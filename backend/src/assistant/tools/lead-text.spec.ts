import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { OptedOutError } from '@/telnyx/sms.service';
import { sendLeadText, textBlocker, textNotes, type LeadTextDeps, type TextLead } from './lead-text';

const ORG = 'org-1';
const auth: AuthContext = { userId: 'user-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };
/** Noon in Austin: inside every texting window. */
const NOON_AUSTIN = new Date('2026-11-25T18:00:00Z');
/** 22:00 in Austin: after the office's quiet hours start at 21:00. */
const NIGHT_AUSTIN = new Date('2026-11-26T04:00:00Z');

const lead = (over: Partial<TextLead> = {}): TextLead => ({
  id: 'lead-1',
  firstName: 'Maria',
  lastName: 'Lopez',
  phone: '(512) 555-0101',
  normalizedPhone: '+15125550101',
  timezone: 'America/Chicago',
  dncStatus: false,
  consentStatus: 'granted',
  takenOverById: null,
  takenOverBy: null,
  updatedAt: new Date(),
  ...over,
});

function deps(opts: { suppressed?: boolean; sendError?: Error } = {}) {
  const d = {
    prisma: {
      contactSuppression: { findMany: vi.fn(async () => (opts.suppressed ? [{ normalizedPhone: '+15125550101' }] : [])) },
      message: { create: vi.fn(async () => ({ id: 'msg-1' })), update: vi.fn(async () => ({})) },
      lead: { update: vi.fn(async () => ({})) },
      user: { findFirst: vi.fn(async () => ({ firstName: 'Sunny', lastName: 'Patel', email: 's@x.test' })) },
    },
    sms: {
      sendSms: vi.fn(async (_org: string, _to: string, text: string) => {
        if (opts.sendError) throw opts.sendError;
        return { id: 'tx-1', text: `${text}\nReply STOP to opt out` };
      }),
    },
    conversations: { appendToChat: vi.fn(async () => undefined) },
    optOuts: { optOut: vi.fn(async () => []) },
    followup: { guardrailsFor: vi.fn(async () => ({ timeZone: 'America/Chicago', quiet: { start: '21:00', end: '08:00' }, skipDays: [0], limits: {} })) },
    state: { quietly: vi.fn() },
    events: { publish: vi.fn() },
  };
  return d as typeof d & LeadTextDeps;
}

afterEach(() => vi.useRealTimers());

describe('texting a lead: when it may go', () => {
  it('goes inside the hours on the lead clock', async () => {
    expect(await textBlocker(deps(), auth, lead(), NOON_AUSTIN)).toBeNull();
  });

  it('is held at night on the lead clock, until the later of the law and the office allows', async () => {
    const why = await textBlocker(deps(), auth, lead(), NIGHT_AUSTIN);
    expect(why).toMatch(/outside texting hours/);
    // The office allows 08:00, but Texas law starts at 09:00.
    expect(why).toMatch(/Legal calling hours \(US-TX\)/);
    expect(why).toMatch(/9:00 AM CST/);
  });

  it("ignores the office's days off: a person chose to text", async () => {
    // A Sunday noon in Austin; skipDays has Sunday.
    expect(await textBlocker(deps(), auth, lead(), new Date('2026-11-29T18:00:00Z'))).toBeNull();
  });

  it('refuses a lead with no number, do-not-contact, no consent or a suppressed number', async () => {
    expect(await textBlocker(deps(), auth, lead({ phone: null, normalizedPhone: null }), NOON_AUSTIN)).toMatch(/no phone/);
    expect(await textBlocker(deps(), auth, lead({ dncStatus: true }), NOON_AUSTIN)).toMatch(/not to be contacted/);
    expect(await textBlocker(deps(), auth, lead({ consentStatus: 'revoked' }), NOON_AUSTIN)).toMatch(/withdrew consent/);
    // Consent still pending counts as none.
    expect(await textBlocker(deps(), auth, lead({ consentStatus: 'pending' }), NOON_AUSTIN)).toMatch(/has not given consent/);
    expect(await textBlocker(deps({ suppressed: true }), auth, lead(), NOON_AUSTIN)).toMatch(/number asked/);
  });

  it('leaves a chat another agent took over to that agent, but not one the user holds', async () => {
    const theirs = lead({ takenOverById: 'agent-2', takenOverBy: { firstName: 'Priya', lastName: 'Shah', email: 'p@x.test' } });
    expect(await textBlocker(deps(), auth, theirs, NOON_AUSTIN)).toMatch(/Priya Shah has taken over/);
    expect(await textBlocker(deps(), auth, lead({ takenOverById: auth.userId }), NOON_AUSTIN)).toBeNull();
  });

  it('tells the card the text goes from the office number, and who answers a reply', () => {
    expect(textNotes(auth, lead())).toMatch(/office number/);
    expect(textNotes(auth, lead())).toMatch(/AI answers/);
    expect(textNotes(auth, lead({ takenOverById: auth.userId }))).not.toMatch(/AI answers/);
  });
});

describe('texting a lead: sending', () => {
  it("keeps the text under the user's name, as it went out, and tells the AI chat", async () => {
    const d = deps();
    const result = await sendLeadText(d, auth, lead(), 'Hi Maria, still looking in Austin?');
    expect(d.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: ORG, leadId: 'lead-1', senderType: 'user', senderUserId: 'user-1', deliveryStatus: 'pending' }),
    });
    expect(d.sms.sendSms).toHaveBeenCalledWith(ORG, '(512) 555-0101', 'Hi Maria, still looking in Austin?', { outreach: true });
    expect(d.prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg-1' },
      data: expect.objectContaining({ body: 'Hi Maria, still looking in Austin?\nReply STOP to opt out', deliveryStatus: 'sent', providerMessageId: 'tx-1' }),
    });
    expect(d.conversations.appendToChat).toHaveBeenCalledWith(ORG, '(512) 555-0101', 'assistant', expect.stringContaining('Sunny Patel'), expect.any(Date));
    expect(d.state.quietly).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_sent', source: 'assistant', actor: { type: 'user', id: 'user-1' } }));
    expect(result.footerAdded).toBe(true);
  });

  it('opts the number out when Telnyx says it replied STOP, and marks the text failed', async () => {
    const d = deps({ sendError: new OptedOutError('Telnyx refused the text: this number replied STOP to us (40300)') });
    await expect(sendLeadText(d, auth, lead(), 'Hi')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(d.prisma.message.update).toHaveBeenCalledWith({ where: { id: 'msg-1' }, data: expect.objectContaining({ deliveryStatus: 'failed' }) });
    expect(d.optOuts.optOut).toHaveBeenCalledWith(ORG, { leadId: 'lead-1' }, expect.objectContaining({ source: 'sms_send' }));
  });

  it('reports any other failure without opting out', async () => {
    const d = deps({ sendError: new Error('Telnyx failed 500: down') });
    await expect(sendLeadText(d, auth, lead(), 'Hi')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(d.optOuts.optOut).not.toHaveBeenCalled();
  });
});

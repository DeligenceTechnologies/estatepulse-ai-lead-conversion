import { describe, expect, it, vi } from 'vitest';
import { InboundSmsService } from './inbound-sms.service';

/** STOP and START as Telnyx honours them; anything else a lead texts is a reply a person picks up. */

const ORG = 'org-1';
const LEAD = 'lead-1';

function setup(lead: { dncStatus: boolean }) {
  const txLead = { update: vi.fn(), updateMany: vi.fn() };
  const prisma = {
    message: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    lead: { findFirst: vi.fn().mockResolvedValue({ id: LEAD, firstResponseAt: null, ...lead }), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(async (run: (t: unknown) => Promise<unknown>) => run({ lead: txLead, sequenceEnrollment: { updateMany: vi.fn() } })),
  };
  const creds = { orgForNumber: vi.fn().mockResolvedValue(ORG) };
  const followup = { stopForLead: vi.fn(), pauseForLead: vi.fn() };
  const svc = new InboundSmsService(prisma as any, creds as any, followup as any);
  const text = (body: string) => svc.onMessageReceived({ id: `m-${body}`, from: { phone_number: '+14155550111' }, to: [{ phone_number: '+14155550000' }], text: body });
  return { text, prisma, txLead, followup };
}

const optedIn = (txLead: { update: ReturnType<typeof vi.fn> }) =>
  txLead.update.mock.calls.some(([arg]) => arg?.data?.consentSource === 'sms_start');

describe('InboundSmsService keywords', () => {
  it('"Yes" from a lead still in outreach is a reply: automation pauses for a person, nothing about consent changes', async () => {
    const { text, prisma, txLead, followup } = setup({ dncStatus: false });
    await text('Yes');
    expect(optedIn(txLead)).toBe(false);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: expect.objectContaining({ automationPaused: true }) });
    expect(followup.pauseForLead).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('"Start" from a lead who never opted out is a reply too', async () => {
    const { text, txLead, followup } = setup({ dncStatus: false });
    await text('START');
    expect(optedIn(txLead)).toBe(false);
    expect(followup.pauseForLead).toHaveBeenCalled();
  });

  it('START or UNSTOP from an opted-out lead lifts do-not-contact (what Telnyx honours)', async () => {
    for (const word of ['START', 'unstop']) {
      const { text, txLead } = setup({ dncStatus: true });
      await text(word);
      expect(optedIn(txLead)).toBe(true);
    }
  });

  it('"Yes" from an opted-out lead does not lift it: Telnyx keeps the block, so the database must too', async () => {
    const { text, txLead } = setup({ dncStatus: true });
    await text('yes');
    expect(optedIn(txLead)).toBe(false);
  });

  it('STOP still opts out', async () => {
    const { text, followup } = setup({ dncStatus: false });
    await text('Stop');
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'opted_out', expect.anything());
  });
});

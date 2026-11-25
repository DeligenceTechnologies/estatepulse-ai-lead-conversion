import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { fakeRefs } from './fake-refs.test';
import { outreachTools } from './outreach.tools';

const ORG = 'org-1';
const LEAD = 'lead-1';
const SEQ = 'seq-1';
const NOON_AUSTIN = new Date('2026-11-25T18:00:00Z');

const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read', 'lead.update', 'automation.read', 'automation.update'] };

const baseLead = {
  id: LEAD,
  firstName: 'Maria',
  lastName: 'Lopez',
  phone: '(512) 555-0101',
  normalizedPhone: '+15125550101',
  timezone: 'America/Chicago',
  dncStatus: false,
  consentStatus: 'granted',
  takenOverById: null,
  takenOverBy: null,
  status: 'contacting',
  automationPaused: false,
  firstContactAt: null as Date | null,
  callbackAt: null as Date | null,
  textBackAt: null as Date | null,
  updatedAt: NOON_AUSTIN,
};

const sequence = {
  id: SEQ,
  name: 'Nurture 30',
  description: 'Gentle check-ins',
  status: 'active',
  enrollTriggers: ['needs_time'],
  activeCount: 4,
  steps: [
    { stepOrder: 1, actionType: 'sms', delayMinutes: 0 },
    { stepOrder: 2, actionType: 'voice', delayMinutes: 2 * 24 * 60 },
  ],
};

function setup(opts: { lead?: Partial<typeof baseLead>; enrollments?: object[]; running?: boolean; canReach?: boolean; skipped?: object[]; firstContactAfterEnroll?: boolean } = {}) {
  const lead = { ...baseLead, ...opts.lead };
  const tx = {
    lead: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    lead: {
      findFirst: vi.fn(async (args: any) =>
        args?.select?.firstContactAt && Object.keys(args.select).length === 1
          ? { firstContactAt: opts.firstContactAfterEnroll === false ? null : NOON_AUSTIN }
          : lead,
      ),
      update: vi.fn(async () => ({})),
    },
    sequenceEnrollment: {
      findMany: vi.fn(async () => opts.enrollments ?? []),
      findFirst: vi.fn(async () => (opts.enrollments?.[0] ?? null)),
    },
    contactSuppression: { findMany: vi.fn(async () => []) },
    message: { create: vi.fn(async () => ({ id: 'msg-1' })), update: vi.fn(async () => ({})) },
    user: { findFirst: vi.fn(async () => ({ firstName: 'Sunny', lastName: 'Patel', email: 's@x.test' })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const followup = {
    guardrailsFor: vi.fn(async () => ({ timeZone: 'America/Chicago', quiet: { start: '21:00', end: '08:00' }, skipDays: [], limits: {} })),
    stopForLead: vi.fn(async () => 1),
    listSequences: vi.fn(async () => [sequence]),
    getSequence: vi.fn(async () => sequence),
    enrollLeads: vi.fn(async (_o: string, _s: string, input: { dryRun?: boolean }) =>
      input.dryRun ? { matched: 1, enrolled: 0, skipped: opts.skipped ?? [], dryRun: true } : { matched: 1, enrolled: 1, skipped: [], dryRun: false },
    ),
  };
  const state = { quietly: vi.fn(), record: vi.fn(async () => undefined) };
  const events = { publish: vi.fn() };
  const deps = {
    prisma,
    engine: {
      setStatus: vi.fn(async () => true),
      enroll: vi.fn(async () => undefined),
      canReachLeads: vi.fn(async () => opts.canReach ?? true),
      isRunning: vi.fn(() => opts.running ?? false),
      stopStrategy: vi.fn(),
    },
    strategies: { getStrategy: vi.fn(async () => ({ name: 'Speed to lead', steps: [{}, {}, {}, {}, {}] })) },
    followup,
    state,
    text: {
      prisma,
      sms: { sendSms: vi.fn(async (_o: string, _t: string, text: string) => ({ id: 'tx-1', text })) },
      conversations: { appendToChat: vi.fn(async () => undefined) },
      optOuts: { optOut: vi.fn() },
      followup,
      state,
      events,
    },
  };
  const tools = Object.fromEntries(outreachTools(deps as never).map((t) => [t.name, t as any]));
  const refs = fakeRefs();
  return { deps, prisma, tx, tools, refs, ctx: { auth: owner, refs } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOON_AUSTIN);
});
afterEach(() => vi.useRealTimers());

async function withLead(s: ReturnType<typeof setup>) {
  await s.refs.issue('lead', [LEAD]);
  return s;
}

describe('text_send', () => {
  it('shows the number and the exact words, then sends exactly those', async () => {
    const s = await withLead(setup());
    const input = { lead: 'L1', text: 'Hi Maria, are you free for a call tomorrow?' };
    const card = await s.tools.text_send.preview(s.ctx, input);
    expect(card.title).toBe('Text Maria Lopez');
    expect(card.changes).toEqual([
      { field: 'To', from: null, to: '(512) 555-0101' },
      { field: 'Message', from: null, to: input.text },
    ]);
    expect(await s.tools.text_send.run(s.ctx, input)).toEqual({ sent: true, lead: 'L1' });
    expect(s.deps.text.sms.sendSms).toHaveBeenCalledWith(ORG, '(512) 555-0101', input.text, { outreach: true });
  });

  it('checks again at send time: a card approved after quiet hours began sends nothing', async () => {
    const s = await withLead(setup());
    const input = { lead: 'L1', text: 'Hi Maria' };
    await s.tools.text_send.preview(s.ctx, input);
    vi.setSystemTime(new Date('2026-11-26T04:00:00Z'));
    await expect(s.tools.text_send.run(s.ctx, input)).rejects.toThrow(/^Not sent\. It is outside texting hours/);
    expect(s.deps.text.sms.sendSms).not.toHaveBeenCalled();
  });

  it('refuses a do-not-contact lead, or one whose consent is still pending, before any card', async () => {
    const dnc = await withLead(setup({ lead: { dncStatus: true } }));
    await expect(dnc.tools.text_send.preview(dnc.ctx, { lead: 'L1', text: 'Hi' })).rejects.toThrow(/not to be contacted/);
    const pending = await withLead(setup({ lead: { consentStatus: 'pending' } }));
    await expect(pending.tools.text_send.preview(pending.ctx, { lead: 'L1', text: 'Hi' })).rejects.toThrow(/has not given consent/);
  });
});

describe('lead_set_status', () => {
  it('shows the move and what it stops, and records the confirming person', async () => {
    const s = await withLead(setup());
    const card = await s.tools.lead_set_status.preview(s.ctx, { lead: 'L1', status: 'not_interested', reason: 'Bought elsewhere' });
    expect(card.changes).toEqual([
      { field: 'Status', from: 'Contacting', to: 'Not interested' },
      { field: 'Reason', from: null, to: 'Bought elsewhere' },
    ]);
    expect(card.summary).toMatch(/outreach and follow-up sequences for this lead stop/);
    await s.tools.lead_set_status.run(s.ctx, { lead: 'L1', status: 'not_interested', reason: 'Bought elsewhere' });
    expect(s.deps.engine.setStatus).toHaveBeenCalledWith(ORG, LEAD, 'not_interested', 'Bought elsewhere', {
      followUpReason: undefined,
      actor: { type: 'user', id: 'owner-1' },
      source: 'assistant',
    });
  });

  it('passes the follow-up reason only with follow-up', async () => {
    const s = await withLead(setup());
    await s.tools.lead_set_status.run(s.ctx, { lead: 'L1', status: 'follow_up', followUpReason: 'needs_time' });
    expect((s.deps.engine.setStatus.mock.calls[0] as any[])[4].followUpReason).toBe('needs_time');
  });

  it('refuses a move to the status the lead already has', async () => {
    const s = await withLead(setup());
    await expect(s.tools.lead_set_status.preview(s.ctx, { lead: 'L1', status: 'contacting' })).rejects.toThrow(/already Contacting/);
  });
});

describe('outreach_start', () => {
  it('names the strategy on the card and starts it', async () => {
    const s = await withLead(setup());
    const card = await s.tools.outreach_start.preview(s.ctx, { lead: 'L1' });
    expect(card.changes).toEqual([{ field: 'Strategy', from: null, to: 'Speed to lead (5 steps)' }]);
    expect(await s.tools.outreach_start.run(s.ctx, { lead: 'L1' })).toEqual({ started: true });
    expect(s.deps.engine.enroll).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('refuses a lead already contacted, a paused one, and an office with no number', async () => {
    const started = await withLead(setup({ lead: { firstContactAt: new Date('2026-11-20T10:00:00Z') } }));
    await expect(started.tools.outreach_start.preview(started.ctx, { lead: 'L1' })).rejects.toThrow(/already started for this lead on 2026-11-20/);
    const paused = await withLead(setup({ lead: { automationPaused: true } }));
    await expect(paused.tools.outreach_start.preview(paused.ctx, { lead: 'L1' })).rejects.toThrow(/paused for this lead/);
    const noNumber = await withLead(setup({ canReach: false }));
    await expect(noNumber.tools.outreach_start.preview(noNumber.ctx, { lead: 'L1' })).rejects.toThrow(/Connect a phone number/);
  });

  it('says so when the engine did not start it', async () => {
    const s = await withLead(setup({ firstContactAfterEnroll: false }));
    await expect(s.tools.outreach_start.run(s.ctx, { lead: 'L1' })).rejects.toThrow(/did not start/);
  });
});

describe('outreach_stop', () => {
  it('lists what stops, including a promised callback and a sequence', async () => {
    const s = await withLead(setup({ running: true, lead: { callbackAt: new Date('2026-11-26T15:00:00Z') }, enrollments: [{ sequence: { name: 'Nurture 30' } }] }));
    const card = await s.tools.outreach_stop.preview(s.ctx, { lead: 'L1' });
    expect(card.changes[0]).toEqual({ field: 'Stops', from: null, to: 'Outreach strategy, Sequence "Nurture 30", A callback the AI promised' });
    expect(card.summary).toMatch(/AI still answers/);
  });

  it('pauses the lead, drops promises, stops sequences and the strategy, and logs who did it', async () => {
    const s = await withLead(setup({ running: true }));
    expect(await s.tools.outreach_stop.run(s.ctx, { lead: 'L1', reason: 'Working with another agent' })).toEqual({ stopped: true, sequencesStopped: 1 });
    expect(s.tx.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { automationPaused: true, callbackAt: null, textBackAt: null } });
    expect(s.deps.followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'stopped_by_user', s.tx);
    expect(s.deps.state.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outreach_stopped', source: 'assistant', actor: { type: 'user', id: 'owner-1' }, reason: 'Working with another agent' }),
      s.tx,
    );
    expect(s.deps.engine.stopStrategy).toHaveBeenCalledWith(ORG, LEAD, 'assistant', 'Working with another agent');
  });

  it('refuses when nothing is left to stop', async () => {
    const s = await withLead(setup({ lead: { automationPaused: true } }));
    await expect(s.tools.outreach_stop.preview(s.ctx, { lead: 'L1' })).rejects.toThrow(/already stopped/);
  });
});

describe('sequences', () => {
  it('lists sequences as refs with their steps in words', async () => {
    const s = setup();
    expect(await s.tools.sequence_list.run(s.ctx, {})).toEqual([
      { ref: 'S1', name: 'Nurture 30', description: 'Gentle check-ins', status: 'active', startsWhen: ['needs_time'], steps: ['text right away', 'AI call after 2 days'], leadsActive: 4 },
    ]);
  });

  it('adds one lead after the checks, and says when the first step goes', async () => {
    const s = await withLead(setup());
    await s.refs.issue('sequence', [SEQ]);
    const card = await s.tools.sequence_enroll.preview(s.ctx, { lead: 'L1', sequence: 'S1' });
    expect(card.summary).toMatch(/first text goes right away/);
    expect(await s.tools.sequence_enroll.run(s.ctx, { lead: 'L1', sequence: 'S1' })).toEqual({ enrolled: true });
    expect(s.deps.followup.enrollLeads).toHaveBeenLastCalledWith(ORG, SEQ, { leadIds: [LEAD] }, 'owner-1');
  });

  it('refuses a lead already in a sequence, or still in the strategy', async () => {
    const inOne = await withLead(setup({ enrollments: [{ sequence: { name: 'Nurture 30' } }] }));
    await inOne.refs.issue('sequence', [SEQ]);
    await expect(inOne.tools.sequence_enroll.preview(inOne.ctx, { lead: 'L1', sequence: 'S1' })).rejects.toThrow(/already in "Nurture 30"/);

    const inStrategy = await withLead(setup({ skipped: [{ leadId: LEAD, leadName: 'Maria Lopez', reason: 'in_strategy' }] }));
    await inStrategy.refs.issue('sequence', [SEQ]);
    await expect(inStrategy.tools.sequence_enroll.preview(inStrategy.ctx, { lead: 'L1', sequence: 'S1' })).rejects.toThrow(/still in the AI outreach strategy/);
  });
});

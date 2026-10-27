import { LeadStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inQuietHours } from '@/common/utils/quiet-hours';
import { EngineService } from '@/telnyx/engine.service';
import { SAFETY_RULES, leadStop, type SafetyCheck } from './safety-rules';

/**
 * The list the strategy and sequence screens show is the list the code enforces: every rule shown
 * stops (or holds) a step for real, and every way a lead's state stops a step is on the list.
 */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const steps = [{ id: 's1', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi' }];

/** Runs one strategy step for a lead in this state, with the guard answering `hold`; says whether the text went. */
async function sends(lead: Record<string, unknown>, hold: Record<string, unknown> = { kind: 'go' }, quiet = false): Promise<boolean> {
  vi.mocked(inQuietHours).mockReturnValue(quiet);
  const live = { id: LEAD, orgId: ORG, firstName: 'Asha', phone: '+1', status: 'contacting', dncStatus: false, automationPaused: false, ...lead };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue({ ...live, dncStatus: false, automationPaused: false }), findUnique: vi.fn().mockResolvedValue(live), update: vi.fn(), updateMany: vi.fn() },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = { getStrategy: vi.fn().mockResolvedValue({ name: 'S', timing: 'after_previous', guardrails: { respectQuietHours: true, quietHours: { start: '21:00', end: '08:00' } }, steps }) };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'm' }) };
  const guard = {
    check: vi.fn().mockResolvedValue(hold),
    conditionUnmet: vi.fn().mockResolvedValue(null),
    lastRunAt: vi.fn(),
    lastCallEndedAt: vi.fn(),
    record: vi.fn(),
    flagReview: vi.fn(),
    clearReview: vi.fn(),
    isScoredCall: vi.fn(),
  };
  const followup = { stopForLead: vi.fn(), sequenceForTrigger: vi.fn(), enroll: vi.fn() };
  const engine = new EngineService(prisma as any, strategies as any, sms as any, { enqueue: vi.fn() } as any, { exitStrategy: vi.fn(), recordSms: vi.fn() } as any, followup as any, guard as any);
  await engine.enroll(ORG, LEAD);
  await vi.advanceTimersByTimeAsync(1_000);
  engine.onModuleDestroy();
  return sms.sendSms.mock.calls.length > 0;
}

/** A scenario per check: the state or guard answer that trips it. */
const SCENARIOS: Record<SafetyCheck, () => Promise<boolean>> = {
  opted_out: () => sends({ dncStatus: true }),
  meeting_booked: async () => (await sends({ status: 'appointment_booked' })) || (await sends({}, { kind: 'booked' })),
  not_interested: () => sends({ status: 'not_interested' }),
  wrong_number: () => sends({ status: 'invalid' }),
  with_agent: async () => (await sends({ status: 'interested' })) || (await sends({ status: 'appointment_requested' })),
  closed: () => sends({ status: 'closed' }),
  automation_paused: () => sends({ automationPaused: true }),
  call_answered: () => sends({}, { kind: 'answered', call: { id: 'c', endedAt: new Date() } }),
  call_pending: () => sends({}, { kind: 'wait', until: Date.now() + 60_000, reason: 'call_live' }),
  contact_hours: () => sends({}, { kind: 'go' }, true),
};

describe('SAFETY_RULES is what the code enforces', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('as a control, a lead with nothing in the way gets the step', async () => {
    expect(await sends({})).toBe(true);
  });

  it.each(SAFETY_RULES.map((r) => [r.label, r.check] as const))('"%s" stops the step', async (_label, check) => {
    expect(await SCENARIOS[check]()).toBe(false);
  });

  it('every way a lead\'s own state stops a step is on the list', () => {
    const listed = new Set(SAFETY_RULES.map((r) => r.check));
    for (const status of Object.values(LeadStatus)) {
      for (const dncStatus of [false, true]) {
        for (const automationPaused of [false, true]) {
          const check = leadStop({ status, dncStatus, automationPaused });
          if (check) expect(listed.has(check)).toBe(true);
        }
      }
    }
  });

  it('only the strategy ends on an answered call; sequences carry on after its score', () => {
    expect(SAFETY_RULES.find((r) => r.check === 'call_answered')?.appliesTo).toEqual(['strategy']);
  });
});

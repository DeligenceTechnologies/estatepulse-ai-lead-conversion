import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService, MAX_STEP_FAILURES, STEP_FAILED_REVIEW, STEP_RETRY_BASE_MS } from './engine.service';
import type { StrategyStep } from './strategy-store.service';

/**
 * A lead never hangs: a step that throws is tried again with backoff and, past the limit, the
 * lead is parked and flagged; a step is checked once more right before anything goes; a lead
 * whose enrolment failed to load stays claimed for the watcher; a long wait fires once, on time.
 */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const callThenSms: StrategyStep[] = [
  { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'voice' },
  { id: 'b', after: { value: 5, unit: 'minutes' }, channel: 'sms', message: 'Sorry we missed you' },
];

function setup(opts: { steps?: StrategyStep[]; timing?: 'after_previous'; conditional?: boolean } = {}) {
  const live = { id: LEAD, orgId: ORG, firstName: 'Asha', phone: '+12895550111', status: 'contacting', dncStatus: false, automationPaused: false, aiSummary: null };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue(live), findUnique: vi.fn().mockResolvedValue(live), update: vi.fn(), updateMany: vi.fn() },
    call: { count: vi.fn().mockResolvedValue(0) },
    message: { count: vi.fn().mockResolvedValue(0) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = {
    getStrategy: vi.fn().mockResolvedValue({ name: 'S', timing: opts.timing ?? 'after_previous', guardrails: { respectQuietHours: false }, steps: opts.steps ?? callThenSms }),
  };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'm' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job') };
  const activity = { exitStrategy: vi.fn(), recordSms: vi.fn(), recordCallFailed: vi.fn() };
  const followup = { stopForLead: vi.fn(), sequenceForTrigger: vi.fn(), enroll: vi.fn(), liveEnrollment: vi.fn(), pauseForLead: vi.fn(), resumeForLead: vi.fn() };
  const guard = {
    check: vi.fn().mockResolvedValue({ kind: 'go' }),
    conditionUnmet: vi.fn().mockResolvedValue(null),
    stepRuns: vi.fn().mockResolvedValue([]),
    lastCallEndedAt: vi.fn().mockResolvedValue(null),
    record: vi.fn(),
    flagReview: vi.fn(),
    clearReview: vi.fn(),
    isScoredCall: vi.fn().mockResolvedValue(true),
  };
  const config = { get: () => opts.conditional ?? true };
  const engine = new EngineService(prisma as any, strategies as any, sms as any, calls as any, activity as any, followup as any, guard as any, config as any);
  return { engine, prisma, live, sms, calls, activity, guard, followup };
}

describe('EngineService: a step that throws', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('is tried again after a backoff, and goes through once the database is back', async () => {
    const { engine, prisma, calls } = setup();
    prisma.lead.findUnique.mockRejectedValueOnce(new Error('database unreachable')).mockRejectedValueOnce(new Error('database unreachable'));
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(engine.isRunning(LEAD)).toBe(true);
    // First retry after the base wait, the second after twice that.
    await vi.advanceTimersByTimeAsync(STEP_RETRY_BASE_MS);
    expect(calls.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * STEP_RETRY_BASE_MS);
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });

  it('past the limit the lead is flagged, parked for follow-up and no longer run here', async () => {
    const { engine, prisma, guard, activity, calls } = setup();
    prisma.lead.findUnique.mockRejectedValue(new Error('database unreachable'));
    let runningWhileParked: boolean | null = null;
    guard.flagReview.mockImplementation(async () => {
      runningWhileParked = engine.isRunning(LEAD);
    });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(guard.flagReview).toHaveBeenCalledWith(ORG, LEAD, STEP_FAILED_REVIEW);
    // Parked while still counted as running: a watcher poll in between leaves the lead alone.
    expect(runningWhileParked).toBe(true);
    expect(activity.exitStrategy).toHaveBeenCalledWith(LEAD, expect.stringContaining('kept failing'));
    expect(engine.isRunning(LEAD)).toBe(false);
    expect(prisma.lead.findUnique.mock.calls.length).toBe(MAX_STEP_FAILURES + 1);
  });

  it('a strategy that cannot be loaded after the claim leaves the lead claimed for the watcher, not running', async () => {
    const { engine, prisma } = setup();
    (engine as any).strategies.getStrategy.mockRejectedValueOnce(new Error('database unreachable'));
    await engine.enroll(ORG, LEAD);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(engine.isRunning(LEAD)).toBe(false);
  });
});

describe('EngineService: the lead is looked at once more right before a step goes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['replied (automation paused)', { automationPaused: true }],
    ['booked', { status: 'appointment_booked' }],
    ['opted out', { dncStatus: true }],
  ])('a lead that %s while the step was being decided gets nothing, and the strategy stops', async (_label, change) => {
    const { engine, prisma, live, calls, guard } = setup();
    // The guard's check is where the time goes; the lead changes under it.
    guard.check.mockImplementationOnce(async () => {
      prisma.lead.findUnique.mockResolvedValue({ ...live, ...change });
      return { kind: 'go' };
    });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(guard.record).not.toHaveBeenCalled();
    expect(engine.isRunning(LEAD)).toBe(false);
  });
});

describe('EngineService: resume reads the step record (a queued call has no row yet)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const contacted = new Date(NOW.getTime() - 2 * MIN);
  const queuedStep1 = [{ stepNumber: 1, channel: 'voice', outcome: 'queued', createdAt: contacted }];

  it('pause then resume while the call is still in the queue: the call is not queued again, and the text waits its time after the queued step', async () => {
    const { engine, prisma, calls, sms, guard } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.enqueue).toHaveBeenCalledOnce();
    expect(calls.enqueue).toHaveBeenCalledWith(expect.anything(), { dedupeKey: `strategy:${LEAD}:${NOW.getTime()}:1` });

    prisma.lead.findFirst.mockResolvedValue({ dncStatus: false, firstContactAt: NOW, status: 'contacting', automationPaused: false });
    guard.stepRuns.mockResolvedValue([{ stepNumber: 1, channel: 'voice', outcome: 'queued', createdAt: NOW }]);
    await engine.setAutomationPaused(ORG, LEAD, true);
    expect(engine.isRunning(LEAD)).toBe(false);
    await engine.setAutomationPaused(ORG, LEAD, false);
    expect(engine.isRunning(LEAD)).toBe(true);
    expect(guard.stepRuns).toHaveBeenCalledWith(LEAD, `strategy:${NOW.getTime()}:`);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls.enqueue).toHaveBeenCalledOnce();
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });

  it('after a restart, the same: the queued call is not queued again, and the next step counts from the record', async () => {
    const { engine, prisma, calls, sms, guard } = setup();
    prisma.lead.findFirst.mockResolvedValue({ firstContactAt: contacted, status: 'contacting', dncStatus: false, automationPaused: false });
    guard.stepRuns.mockResolvedValue(queuedStep1);
    expect(await engine.resume(ORG, LEAD)).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * MIN - 1);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(sms.sendSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });

  it('a call that failed to queue is not retried by a resume either, and the call key is stable across it', async () => {
    const { engine, prisma, calls, guard } = setup();
    prisma.lead.findFirst.mockResolvedValue({ firstContactAt: contacted, status: 'contacting', dncStatus: false, automationPaused: false });
    guard.stepRuns.mockResolvedValue([]);
    expect(await engine.resume(ORG, LEAD)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.enqueue).toHaveBeenCalledWith(expect.anything(), { dedupeKey: `strategy:${LEAD}:${contacted.getTime()}:1` });
  });
});

describe('EngineService: a resume also trusts the calls and texts on record (a step record can be lost)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const smsThenCall: StrategyStep[] = [
    { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi' },
    { id: 'b', after: { value: 5, unit: 'minutes' }, channel: 'voice' },
  ];

  it('the text went but its record was lost: after a restart the text on record counts, and it is not sent again', async () => {
    const { engine, prisma, sms, calls, guard } = setup({ steps: smsThenCall });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(sms.sendSms).toHaveBeenCalledOnce();
    // The record's write failed (bookkeeping, it never throws), the process went down, the lead is resumed.
    engine.onModuleDestroy();
    prisma.lead.findFirst.mockResolvedValue({ firstContactAt: NOW, status: 'contacting', dncStatus: false, automationPaused: false });
    prisma.message.count.mockResolvedValue(1);
    guard.stepRuns.mockResolvedValue([]);
    expect(await engine.resume(ORG, LEAD)).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sms.sendSms).toHaveBeenCalledOnce();
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });

  it('a lead that ran with the flag off and is resumed with it on (no record at all): its call and text on record count, nothing repeats', async () => {
    const { engine, prisma, sms, calls, guard, activity } = setup();
    prisma.lead.findFirst.mockResolvedValue({ firstContactAt: new Date(NOW.getTime() - 2 * MIN), status: 'contacting', dncStatus: false, automationPaused: false });
    prisma.call.count.mockResolvedValue(1);
    prisma.message.count.mockResolvedValue(1);
    guard.stepRuns.mockResolvedValue([]);
    expect(await engine.resume(ORG, LEAD)).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(activity.exitStrategy).toHaveBeenCalledWith(LEAD, expect.stringContaining('Strategy complete'));
  });
});

describe('EngineService: a wait longer than one timer can hold', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('fires once, when it is due, not at once (an older strategy may still carry a 30-day step)', async () => {
    const steps: StrategyStep[] = [
      { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi' },
      { id: 'b', after: { value: 30, unit: 'days' }, channel: 'sms', message: 'Still looking?' },
    ];
    const { engine, sms } = setup({ steps, timing: undefined, conditional: false });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(25 * DAY);
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * DAY);
    expect(sms.sendSms).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callJobId } from '@/queue/queue.constants';
import { QUEUE_READ_TIMEOUT_MS, QUEUE_STUCK_REVIEW, SCORE_MISSING_REVIEW, StepGuard, callOutcomeOf, callResult } from './step-guard.service';

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;
const SEC = 1_000;

const call = (over: Record<string, unknown> = {}) => ({
  id: 'call-1',
  status: 'completed',
  createdAt: ago(10 * MIN),
  startedAt: ago(10 * MIN),
  answeredAt: null as Date | null,
  endedAt: null as Date | null,
  durationSeconds: null as number | null,
  extractedIntel: null as unknown,
  ...over,
});
/** A picked-up call that ended `endedMinAgo` minutes ago after `talkSec` seconds of talk. */
const pickedUp = (endedMinAgo: number, talkSec: number, extraction?: Record<string, unknown>) =>
  call({
    createdAt: ago(endedMinAgo * MIN + talkSec * SEC + 20 * SEC),
    answeredAt: ago(endedMinAgo * MIN + talkSec * SEC),
    endedAt: ago(endedMinAgo * MIN),
    extractedIntel: extraction ? { qualification: { extraction } } : null,
  });

describe('callResult', () => {
  it.each([
    ['a provider failure', call({ status: 'failed' }), 'failed'],
    ['no answer or busy', call({ status: 'no_answer' }), 'not_answered'],
    ['a pick-up that ended 2 minutes ago, analysis not in yet', pickedUp(2, 45), 'awaiting_analysis'],
    ['a voicemail over 30s the analysis says reached no one', pickedUp(2, 90, { reached_person: false }), 'not_answered'],
    ['a 10s pick-up the analysis says reached a person', pickedUp(2, 10, { reached_person: true }), 'answered'],
    ['an older analysis without the field that heard a real exchange', pickedUp(2, 10, { not_interested: true }), 'answered'],
    ['an older analysis that cannot tell: the talk time decides', pickedUp(2, 45, {}), 'answered'],
    ['no analysis 15 minutes on, 45s of talk', pickedUp(20, 45), 'answered'],
    ['no analysis 15 minutes on, a 12s pick-up', pickedUp(20, 12), 'not_answered'],
    ['an older row timed from dialing only', call({ createdAt: ago(30 * MIN), durationSeconds: 40 }), 'answered'],
    ['a call in progress', call({ status: 'in_progress', answeredAt: ago(2 * MIN) }), 'live'],
    ['one in progress whose hang-up never came', call({ status: 'in_progress', answeredAt: ago(31 * MIN) }), 'answered'],
    [
      'one in progress whose hang-up never came, analysed as reaching no one',
      call({ status: 'in_progress', answeredAt: ago(31 * MIN), extractedIntel: { qualification: { extraction: { reached_person: false } } } }),
      'not_answered',
    ],
    ['a call ringing', call({ status: 'ringing', startedAt: ago(20 * SEC) }), 'live'],
    ['one stuck ringing', call({ status: 'ringing', startedAt: ago(6 * MIN) }), 'not_answered'],
  ])('%s → %s', (_label, row, expected) => {
    expect(callResult(row as any, NOW)).toBe(expected);
  });
});

function setup(
  opts: {
    calls?: ReturnType<typeof call>[];
    meetings?: number;
    queued?: { callKey: string; createdAt: Date }[];
    job?: 'delayed' | 'none' | 'unreadable';
    lastCall?: ReturnType<typeof call> | null;
    replies?: number;
  } = {},
) {
  const prisma = {
    calendarMeeting: { count: vi.fn().mockResolvedValue(opts.meetings ?? 0) },
    call: { findMany: vi.fn().mockResolvedValue(opts.calls ?? []), findFirst: vi.fn().mockResolvedValue(opts.lastCall ?? null) },
    message: { count: vi.fn().mockResolvedValue(opts.replies ?? 0) },
    outreachStepRun: { findMany: vi.fn().mockResolvedValue(opts.queued ?? []), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    lead: { updateMany: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  // The call queue: a job still waiting (delayed for quiet hours or capacity), none left, or Redis unreachable.
  const getJob =
    opts.job === 'unreadable'
      ? vi.fn().mockRejectedValue(new Error('redis down'))
      : vi.fn().mockResolvedValue(opts.job === 'delayed' ? { getState: async () => 'delayed' } : null);
  const queue = { getJob };
  const flagged = () => prisma.$executeRaw.mock.calls.map((c) => c.find((v: unknown) => typeof v === 'string' && v.length > 40));
  return { guard: new StepGuard(prisma as any, queue as any), prisma, queue, flagged };
}

describe('StepGuard.check', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  const since = ago(30 * MIN);
  const strategy = { orgId: ORG, leadId: LEAD, since, endOnAnswer: true };
  const sequence = { ...strategy, endOnAnswer: false };
  const wait = (reason: string) => ({ kind: 'wait', until: NOW + MIN, reason });

  it('nothing on record: go', async () => {
    expect(await setup().guard.check(strategy)).toEqual({ kind: 'go' });
  });

  it('an upcoming meeting linked to the lead: booked', async () => {
    const { guard, prisma } = setup({ meetings: 1 });
    expect(await guard.check(strategy)).toEqual({ kind: 'booked' });
    expect(prisma.calendarMeeting.count).toHaveBeenCalledWith({ where: { orgId: ORG, leadId: LEAD, status: 'scheduled', endsAt: { gt: new Date(NOW) } } });
  });

  it('a call ringing or in progress: wait a minute and look again', async () => {
    expect(await setup({ calls: [call({ status: 'in_progress', answeredAt: ago(MIN) })] }).guard.check(strategy)).toEqual(wait('call_live'));
  });

  it('a queued call not yet dialed (quiet hours, capacity): wait while its job is still in the queue', async () => {
    const queued = [{ callKey: 'strategy:lead-1:1:1', createdAt: ago(2 * MIN) }];
    const waiting = setup({ queued, job: 'delayed' });
    expect(await waiting.guard.check(strategy)).toEqual(wait('call_queued'));
    expect(waiting.queue.getJob).toHaveBeenCalledWith(callJobId('strategy:lead-1:1:1'));
    expect(await setup({ queued, job: 'none' }).guard.check(strategy)).toEqual({ kind: 'go' });
  });

  it('a queued call keeps holding the step for hours, and when the queue cannot be read', async () => {
    expect(await setup({ queued: [{ callKey: 'k', createdAt: ago(5 * 60 * MIN) }], job: 'delayed' }).guard.check(strategy)).toEqual(wait('call_queued'));
    expect(await setup({ queued: [{ callKey: 'k', createdAt: ago(2 * MIN) }], job: 'unreadable' }).guard.check(strategy)).toEqual(wait('call_queued'));
  });

  it('a call still queued after a day: stuck, and the lead is flagged for a person to look at', async () => {
    const { guard, flagged } = setup({ queued: [{ callKey: 'k', createdAt: ago(25 * 60 * MIN) }], job: 'delayed' });
    expect(await guard.check(strategy)).toEqual({ kind: 'stuck' });
    expect(flagged()).toEqual([QUEUE_STUCK_REVIEW]);
  });

  it('a queued call that already has its row is not waited on twice', async () => {
    const { guard, queue } = setup({ queued: [{ callKey: 'k', createdAt: ago(5 * MIN) }], calls: [call({ status: 'no_answer', createdAt: ago(4 * MIN) })], job: 'delayed' });
    expect(await guard.check(strategy)).toEqual({ kind: 'go' });
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('a picked-up call waiting for its analysis holds the step, strategy or sequence', async () => {
    expect(await setup({ calls: [pickedUp(2, 90)] }).guard.check(strategy)).toEqual(wait('awaiting_analysis'));
    expect(await setup({ calls: [pickedUp(2, 90)] }).guard.check(sequence)).toEqual(wait('awaiting_analysis'));
  });

  it('a voicemail over 30s the analysis says reached no one does not end the strategy', async () => {
    expect(await setup({ calls: [pickedUp(2, 90, { reached_person: false })] }).guard.check(strategy)).toEqual({ kind: 'go' });
  });

  it('an answered call ends the strategy', async () => {
    const answered = pickedUp(3, 60, { reached_person: true });
    expect(await setup({ calls: [answered] }).guard.check(strategy)).toEqual({ kind: 'answered', call: { id: 'call-1', endedAt: answered.endedAt } });
  });

  it('an answered call from before this run does not end it', async () => {
    const before = call({ createdAt: ago(40 * MIN), answeredAt: ago(39 * MIN), endedAt: ago(35 * MIN), extractedIntel: { qualification: { extraction: { reached_person: true } } } });
    expect(await setup({ calls: [before] }).guard.check(strategy)).toEqual({ kind: 'go' });
  });

  it('a sequence step goes after an answered call; one answered by talk time alone flags the missing score', async () => {
    const scored = setup({ calls: [pickedUp(3, 60, { reached_person: true })] });
    expect(await scored.guard.check(sequence)).toEqual({ kind: 'go' });
    expect(scored.flagged()).toEqual([]);

    const unscored = setup({ calls: [pickedUp(20, 60)] });
    expect(await unscored.guard.check(sequence)).toEqual({ kind: 'go' });
    expect(unscored.flagged()).toEqual([SCORE_MISSING_REVIEW]);
  });
});

describe('StepGuard.conditionUnmet', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  const since = ago(30 * MIN);
  const input = { orgId: ORG, leadId: LEAD, since };
  const no = (detail: string) => ({ reason: 'condition_not_met', detail });

  it('"always", or no condition, never holds a step back', async () => {
    expect(await setup().guard.conditionUnmet('always', input)).toBeNull();
    expect(await setup().guard.conditionUnmet(undefined, input)).toBeNull();
    expect(await setup().guard.conditionUnmet({ match: 'any', rules: [] }, input)).toBeNull();
  });

  it.each([
    ['no answer', call({ status: 'no_answer', createdAt: ago(5 * MIN) }), null],
    ['a short pick-up, no analysis 15 minutes on', pickedUp(20, 8), null],
    ['a voicemail over 30s the analysis says reached no one', pickedUp(2, 90, { reached_person: false }), null],
    ['an answered call', pickedUp(3, 60, { reached_person: true }), no('The call result was a conversation')],
    ['a call the provider never placed', call({ status: 'failed', createdAt: ago(5 * MIN) }), no('The call result was a call that did not connect')],
    ['a call still awaiting its analysis', pickedUp(2, 45), { reason: 'call_unresolved', detail: 'The call had not finished' }],
    ['no call at all (one only queued never counts)', null, no('The call result was no call yet')],
  ])('"only if the call was not answered" after %s', async (_label, last, expected) => {
    expect(await setup({ lastCall: last }).guard.conditionUnmet('call_not_answered', input)).toEqual(expected);
  });

  it('"only if the call was not answered" looks at the calls since `callsSince`, or every call when it is null', async () => {
    const s = setup({ lastCall: call({ status: 'no_answer' }) });
    await s.guard.conditionUnmet('call_not_answered', input);
    expect(s.prisma.call.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { orgId: ORG, leadId: LEAD, createdAt: { gte: since } } }));
    await s.guard.conditionUnmet('call_not_answered', { ...input, callsSince: null });
    expect(s.prisma.call.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { orgId: ORG, leadId: LEAD } }));
  });

  it('"only if the lead hasn\'t replied" holds the step once a reply came in', async () => {
    expect(await setup({ replies: 1 }).guard.conditionUnmet('no_reply', input)).toEqual(no('The lead replied'));
    expect(await setup({ replies: 0 }).guard.conditionUnmet('no_reply', input)).toBeNull();
  });

  it('"only if the lead has not been reached" holds the step after a reply or an answered call', async () => {
    expect(await setup({ replies: 1 }).guard.conditionUnmet('not_reached', input)).toEqual(no('The lead replied'));
    const answered = pickedUp(3, 60, { reached_person: true });
    expect(await setup({ lastCall: answered }).guard.conditionUnmet('not_reached', input)).toEqual(no('The call result was a conversation'));
    expect(await setup({ lastCall: call({ status: 'no_answer', createdAt: ago(5 * MIN) }) }).guard.conditionUnmet('not_reached', input)).toBeNull();
  });
});

describe('StepGuard.record', () => {
  it('stores the run once: a repeated run key is ignored', async () => {
    const { guard, prisma } = setup();
    await guard.record({ orgId: ORG, leadId: LEAD, source: 'strategy', runKey: 'strategy:1:2', stepNumber: 2, channel: 'sms', outcome: 'skipped', reason: 'call_answered' });
    expect(prisma.outreachStepRun.createMany).toHaveBeenCalledWith({
      data: [
        { orgId: ORG, leadId: LEAD, source: 'strategy', enrollmentId: null, runKey: 'strategy:1:2', stepNumber: 2, channel: 'sms', outcome: 'skipped', reason: 'call_answered', detail: null, callKey: null },
      ],
      skipDuplicates: true,
    });
  });

  it('never fails the step it describes', async () => {
    const { guard, prisma } = setup();
    prisma.outreachStepRun.createMany.mockRejectedValue(new Error('db down'));
    await expect(guard.record({ orgId: ORG, leadId: LEAD, source: 'followup', runKey: 'k', stepNumber: 1, channel: 'voice', outcome: 'queued' })).resolves.toBeUndefined();
  });
});

describe('the analysis wait is for connected calls only', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  const strategy = { orgId: ORG, leadId: LEAD, since: ago(30 * MIN), endOnAnswer: true };

  it('a call never answered (no answer, busy, ring timeout) is decided at once, the second it ends', () => {
    expect(callResult(call({ status: 'no_answer', startedAt: ago(70 * SEC), endedAt: ago(0) }) as any, NOW)).toBe('not_answered');
  });

  it('so the step after it is not held: it goes at its own time', async () => {
    const { guard } = setup({ calls: [call({ status: 'no_answer', createdAt: ago(70 * SEC), startedAt: ago(70 * SEC), endedAt: ago(0) })] });
    expect(await guard.check(strategy)).toEqual({ kind: 'go' });
  });

  it('a completed row with no answered_at (written before the column existed) is not held for an analysis', () => {
    expect(callResult(call({ createdAt: ago(3 * MIN), endedAt: ago(MIN), durationSeconds: 12 }) as any, NOW)).toBe('not_answered');
  });
});

describe('answering machine detection in the call result', () => {
  it('a call a machine picked up is voicemail at once, however long it ran, unless its analysis says a person spoke', () => {
    expect(callResult({ ...pickedUp(1, 90), answeredBy: 'machine' } as any, NOW)).toBe('not_answered');
    expect(callResult({ ...pickedUp(1, 90, { reached_person: true }), answeredBy: 'machine' } as any, NOW)).toBe('answered');
    expect(callResult({ ...pickedUp(1, 90), answeredBy: 'human' } as any, NOW)).toBe('awaiting_analysis');
  });
});

describe('callOutcomeOf: the last call in the owner\'s terms', () => {
  it.each([
    ['no call', null, 'none'],
    ['a provider failure', call({ status: 'failed' }), 'failed'],
    ['no answer (ring timeout)', call({ status: 'no_answer', endReason: 'timeout' }), 'no_answer'],
    ['busy', call({ status: 'no_answer', endReason: 'user_busy' }), 'busy'],
    ['declined', call({ status: 'no_answer', endReason: 'call_rejected' }), 'busy'],
    ['a machine picked up', { ...pickedUp(20, 40), answeredBy: 'machine' }, 'voicemail'],
    ['the analysis heard voicemail', pickedUp(2, 90, { reached_person: false }), 'voicemail'],
    ['a short pick-up', pickedUp(20, 8), 'short_pickup'],
    ['a conversation', pickedUp(3, 60, { reached_person: true }), 'conversation'],
    ['a call still awaiting its analysis', pickedUp(2, 45), 'pending'],
  ])('%s → %s', (_label, row, expected) => {
    expect(callOutcomeOf(row as any, NOW)).toBe(expected);
  });
});

describe('StepGuard reads the call queue with a timeout', () => {
  beforeEach(() => {
    // The describes above fake only Date and never restore; a second useFakeTimers would keep that config, so restore first.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('a look at the queue that never answers (Redis hanging) counts as the job still waiting, after QUEUE_READ_TIMEOUT_MS', async () => {
    const { guard, queue } = setup({ queued: [{ callKey: 'k', createdAt: ago(2 * MIN) }] });
    queue.getJob.mockReturnValue(new Promise(() => undefined));
    const pending = guard.check({ orgId: ORG, leadId: LEAD, since: ago(30 * MIN), endOnAnswer: true });
    // The timeout timer is set once the meetings and calls have been read: let those settle (setImmediate is real), then run it down.
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: 'wait', until: NOW + MIN, reason: 'call_queued' });
  });
});

describe('StepGuard.stepRuns', () => {
  it('reads this run\'s record oldest first, by its key prefix', async () => {
    const { guard, prisma } = setup();
    const rows = [{ stepNumber: 1, channel: 'voice', outcome: 'queued', createdAt: ago(MIN) }];
    prisma.outreachStepRun.findMany.mockResolvedValue(rows);
    expect(await guard.stepRuns(LEAD, 'strategy:123:')).toEqual(rows);
    expect(prisma.outreachStepRun.findMany).toHaveBeenCalledWith({
      where: { leadId: LEAD, runKey: { startsWith: 'strategy:123:' } },
      orderBy: { createdAt: 'asc' },
      select: { stepNumber: true, channel: true, outcome: true, createdAt: true },
    });
  });
});

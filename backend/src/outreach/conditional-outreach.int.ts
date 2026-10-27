import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupRunner } from '@/followup/followup.runner';
import { FollowupService } from '@/followup/followup.service';
import { callJobId } from '@/queue/queue.constants';
import { ActivityService } from '@/telnyx/activity.service';
import { EngineService } from '@/telnyx/engine.service';
import { InboundSmsService } from '@/telnyx/inbound-sms.service';
import { LeadAutomationController } from '@/telnyx/lead-automation.controller';
import { StrategyStoreService, toTwoStep, type StrategyStep } from '@/telnyx/strategy-store.service';
import { StepGuard } from './step-guard.service';

/**
 * Conditional outreach against the real database: the two-step strategy, its conditions, the
 * safety rules and the quick actions. Services are built by hand — no Nest app, so the lead
 * watcher, the follow-up runner's poll and the call worker never run, and nothing is ever texted
 * or dialled: SMS and the call queue are stand-ins that record what they were asked to do. Calls
 * are written to the calls table as the webhooks would write them. The follow-up runner is only
 * ever handed this suite's own enrolment. Every test makes its own organization, deleted at the end.
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const audit = new AuditService(prisma);
const strategies = new StrategyStoreService(prisma);
const followup = new FollowupService(prisma, strategies);

const texts: { orgId: string; to: string; text: string }[] = [];
const sms = {
  sendSms: async (orgId: string, to: string, text: string) => {
    texts.push({ orgId, to, text });
    return { id: `msg-${randomUUID()}` };
  },
};
const dialled: { orgId: string; leadId: string; dedupeKey: string }[] = [];
const calls = {
  enqueue: async (data: { orgId: string; leadId: string }, options: { dedupeKey: string }) => {
    dialled.push({ orgId: data.orgId, leadId: data.leadId, dedupeKey: options.dedupeKey });
    return 'job';
  },
};
/** The call queue as the guard reads it: the job ids a test says are still waiting (quiet hours, capacity). */
const waitingJobs = new Set<string>();
const callQueue = { getJob: async (id: string) => (waitingJobs.has(id) ? { getState: async () => 'delayed' } : null) };

const guard = new StepGuard(prisma, callQueue as never);
const activity = new ActivityService(prisma, {} as never, {} as never, {} as never, { extend: async () => undefined, release: async () => undefined } as never, { get: () => 0 } as never);
const engine = new EngineService(prisma, strategies, sms as never, calls as never, activity, followup, guard);
const runnerEnv = { get: (k: string) => ({ FOLLOWUP_BATCH_SIZE: 20, FOLLOWUP_STUCK_AFTER_MS: 600_000, STRATEGY_ENGINE: false })[k] };
const runner = new FollowupRunner(prisma, runnerEnv as never, followup, sms as never, calls as never, activity, guard);
const automation = new LeadAutomationController(engine, audit);

const orgs: string[] = [];
const SEC = 1_000;

afterEach(() => {
  // Timers of a finished test must not run into the next one.
  engine.onModuleDestroy();
});

afterAll(async () => {
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.$disconnect();
});

const callThenSms = (condition: StrategyStep['condition'], wait = 2): StrategyStep[] => [
  { id: 'call', after: { value: 0, unit: 'seconds' }, channel: 'voice', action: 'ai_call' },
  { id: 'sms', after: { value: wait, unit: 'seconds' }, channel: 'sms', action: 'send_sms', message: 'Sorry we missed you, {{firstName}}', condition },
];
const smsThenCall = (condition: StrategyStep['condition'], wait = 2): StrategyStep[] => [
  { id: 'sms', after: { value: 0, unit: 'seconds' }, channel: 'sms', action: 'send_sms', message: 'Hi {{firstName}} from {{brokerage}}' },
  { id: 'call', after: { value: wait, unit: 'seconds' }, channel: 'voice', action: 'ai_call', condition },
];
const guardrails = { respectQuietHours: false, quietHours: { start: '21:00', end: '08:00' }, maxVoiceAttempts: 3 };

/** An organization whose saved strategy is `strategy` (raw JSON, as the database holds it). */
async function setupOrg(strategy: Record<string, unknown>) {
  const org = await prisma.organization.create({ data: { name: `conditional-int ${randomUUID().slice(0, 8)}` } });
  orgs.push(org.id);
  await prisma.organizationSetting.create({
    data: { orgId: org.id, timezone: 'UTC', outreachStrategy: { name: 'Test', guardrails, ...strategy } as unknown as Prisma.InputJsonValue },
  });
  const user = await prisma.user.create({
    data: { orgId: org.id, firstName: 'Test', lastName: 'Owner', email: `conditional-${randomUUID()}@example.test`, password: 'not-a-real-hash' },
  });
  const auth: AuthContext = { organizationId: org.id, userId: user.id, sessionId: randomUUID(), roleIds: [], permissions: [] };
  return { orgId: org.id, auth };
}
const twoStep = (steps: StrategyStep[]) => setupOrg({ timing: 'after_previous', steps });

/** Unique within a run: texts are matched to a lead by its phone, so two leads must never share one. */
let phoneSeq = 0;
const runTag = String(Math.floor(Math.random() * 900) + 100);
async function newLead(orgId: string) {
  const phone = `+1415${runTag}${String(++phoneSeq).padStart(4, '0')}`;
  return prisma.lead.create({
    data: { orgId, firstName: 'Asha', phone, normalizedPhone: phone, phoneValid: true },
    select: { id: true, phone: true },
  });
}

async function waitFor<T>(read: () => Promise<T> | T, done: (v: T) => boolean, ms = 8_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runsOf = async (leadId: string) =>
  (await prisma.outreachStepRun.findMany({ where: { leadId }, orderBy: [{ stepNumber: 'asc' }, { createdAt: 'asc' }] })).map(
    (r) => `${r.stepNumber}:${r.outcome}${r.reason ? `:${r.reason}` : ''}`,
  );
const textsTo = (phone: string | null) => texts.filter((t) => t.to === phone);
const dialsFor = (leadId: string) => dialled.filter((d) => d.leadId === leadId);

/** The call the queued step placed, as the call webhooks leave its row. */
type CallKind = 'no_answer' | 'answered' | 'voicemail_long' | 'failed';
async function callHappened(orgId: string, leadId: string, kind: CallKind) {
  const now = Date.now();
  const at = (s: number) => new Date(now - s * SEC);
  const reached = (r: boolean) => ({ qualification: { extraction: { reached_person: r, summary: r ? 'Talked about buying' : 'Voicemail greeting' } } });
  const data = {
    no_answer: { status: 'no_answer', startedAt: at(40), endedAt: at(0), durationSeconds: 40 },
    failed: { status: 'failed', startedAt: at(1), endedAt: at(0) },
    answered: { status: 'completed', startedAt: at(100), answeredAt: at(90), endedAt: at(0), durationSeconds: 100, extractedIntel: reached(true) },
    voicemail_long: { status: 'completed', startedAt: at(70), answeredAt: at(60), endedAt: at(0), durationSeconds: 70, extractedIntel: reached(false) },
  }[kind];
  await prisma.call.create({ data: { orgId, leadId, provider: 'telnyx', ...data } as Prisma.CallUncheckedCreateInput });
}

/** Enrols, waits for step 1's call to be queued, then records how that call went. */
async function callStepWent(orgId: string, leadId: string, kind: CallKind | null) {
  await engine.enroll(orgId, leadId);
  await waitFor(() => dialsFor(leadId).length, (n) => n === 1);
  if (kind) await callHappened(orgId, leadId, kind);
}

describe('call → SMS, only if the call was not answered', () => {
  it('no answer: the text goes, 2s after the call step', async () => {
    const { orgId } = await twoStep(callThenSms('call_not_answered'));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'no_answer');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:sent']);
    expect(textsTo(lead.phone).map((t) => t.text)).toEqual(['Sorry we missed you, Asha']);
  });

  it('a call never answered is decided at once: the text goes at its own wait, not held for an analysis', async () => {
    const { orgId } = await twoStep(callThenSms('call_not_answered', 3));
    const lead = await newLead(orgId);
    const started = Date.now();
    await callStepWent(orgId, lead.id, 'no_answer');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2, 10_000)).toEqual(['1:queued', '2:sent']);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(3 * SEC);
    expect(took).toBeLessThan(8 * SEC);
  });

  it('answered (the analysis heard a person): no text, the strategy ends and waits for the score', async () => {
    const { orgId } = await twoStep(callThenSms('call_not_answered'));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'answered');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:skipped:call_answered']);
    expect(textsTo(lead.phone)).toEqual([]);
    expect(engine.isRunning(lead.id)).toBe(true);

    // The score arrives: it decides what follows, and the strategy is done.
    await engine.qualified(orgId, lead.id, 'warm', 'WARM — 50.');
    expect(engine.isRunning(lead.id)).toBe(false);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('follow_up');
  });

  it('a voicemail over 30s the analysis says reached no one counts as not answered: the text goes', async () => {
    const { orgId } = await twoStep(callThenSms('call_not_answered'));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'voicemail_long');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:sent']);
  });

  it('a call that never connected (provider failure) is not "not answered": the text is skipped with why', async () => {
    const { orgId } = await twoStep(callThenSms('call_not_answered'));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'failed');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:skipped:condition_not_met']);
    expect((await prisma.outreachStepRun.findFirstOrThrow({ where: { leadId: lead.id, stepNumber: 2 } })).detail).toBe('The call result was a call that did not connect');
    expect(textsTo(lead.phone)).toEqual([]);
  });

  it('a call still in the queue (quiet hours): step 2 waits, and "not answered" is never true for it', async () => {
    const { orgId } = await twoStep(callThenSms('call_not_answered'));
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    const [job] = await waitFor(() => dialsFor(lead.id), (d) => d.length === 1);
    waitingJobs.add(callJobId(job.dedupeKey));
    await sleep(3 * SEC);
    expect(textsTo(lead.phone)).toEqual([]);
    expect(await runsOf(lead.id)).toEqual(['1:queued']);
    expect(await guard.conditionUnmet('call_not_answered', { orgId, leadId: lead.id, since: new Date(Date.now() - 60 * SEC) })).toEqual({
      reason: 'condition_not_met',
      detail: 'The call result was no call yet',
    });
    waitingJobs.clear();
  });

  it('"Always" sends the text after an unanswered call too', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'no_answer');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:sent']);
  });
});

describe("SMS → call, only if the lead hasn't replied", () => {
  it('no reply: the call goes 2s after the text', async () => {
    const { orgId } = await twoStep(smsThenCall('no_reply'));
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:sent', '2:queued']);
    expect(textsTo(lead.phone).length).toBe(1);
    expect(dialsFor(lead.id).length).toBe(1);
  });

  it('a reply pauses everything; resumed by the owner, the call is skipped because the lead replied', async () => {
    const { orgId, auth } = await twoStep(smsThenCall('no_reply', 3));
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    await waitFor(() => textsTo(lead.phone).length, (n) => n === 1);

    const inbound = new InboundSmsService(prisma, { orgForNumber: async () => orgId } as never, followup);
    await inbound.onMessageReceived({ id: `in-${randomUUID()}`, from: { phone_number: lead.phone }, to: [{ phone_number: '+14155550000' }], text: 'Yes, call me tomorrow' });
    await sleep(4 * SEC);
    expect(dialsFor(lead.id)).toEqual([]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).automationPaused).toBe(true);

    await automation.setAutomation(auth, lead.id, { paused: false });
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:sent', '2:skipped:condition_not_met']);
    expect((await prisma.outreachStepRun.findFirstOrThrow({ where: { leadId: lead.id, stepNumber: 2 } })).detail).toBe('The lead replied');
    expect(dialsFor(lead.id)).toEqual([]);
    expect(await prisma.auditLog.count({ where: { orgId, action: 'lead.automation_resumed', entityId: lead.id } })).toBe(1);
  });
});

describe('swap order', () => {
  it('saving SMS → call, then swapped to call → SMS, runs the call first', async () => {
    const { orgId } = await twoStep(smsThenCall('always'));
    const swapped: StrategyStep[] = [
      { id: 'call', after: { value: 0, unit: 'seconds' }, channel: 'voice', action: 'ai_call' },
      { id: 'sms', after: { value: 2, unit: 'seconds' }, channel: 'sms', action: 'send_sms', message: 'Missed you', condition: 'call_not_answered' },
    ];
    const saved = await strategies.saveStrategy(orgId, { steps: swapped });
    expect(saved.timing).toBe('after_previous');
    expect(saved.steps.map((s) => [s.channel, s.onlyIf])).toEqual([
      ['voice', undefined],
      ['sms', { match: 'all', rules: [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] }],
    ]);

    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'no_answer');
    expect(textsTo(lead.phone)).toEqual([]);
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:sent']);
  });

  it('a third step is refused and the saved strategy stays as it was', async () => {
    const { orgId } = await twoStep(smsThenCall('always'));
    const before = await strategies.getStrategy(orgId);
    await expect(strategies.saveStrategy(orgId, { steps: [...smsThenCall('always'), { id: 'x', after: { value: 1, unit: 'minutes' }, channel: 'sms', message: 'x' }] })).rejects.toThrow(/exactly two steps/);
    expect(await strategies.getStrategy(orgId)).toEqual(before);
  });
});

describe('booked', () => {
  it('a meeting on the calendar for the lead: step 2 is skipped and the lead is booked', async () => {
    const { orgId } = await twoStep(callThenSms('always', 3));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'no_answer');
    const connection = await prisma.calendarConnection.create({
      data: { orgId, provider: 'calendly', status: 'inactive', accountId: 'acct', workspaceType: 'personal', workspaceId: 'ws', credentials: 'not-real' },
    });
    await prisma.calendarMeeting.create({
      data: {
        orgId,
        connectionId: connection.id,
        externalId: `ext-${randomUUID()}`,
        title: 'Buyer consult',
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 86_400_000 + 1_800_000),
        status: 'scheduled',
        leadId: lead.id,
      },
    });
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:skipped:booked']);
    expect(textsTo(lead.phone)).toEqual([]);
    expect(await waitFor(async () => (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status, (st) => st === 'appointment_booked')).toBe('appointment_booked');
  });

  it('"Mark as booked" mid-strategy: booked, nothing more goes, and it is audited', async () => {
    const { orgId, auth } = await twoStep(callThenSms('always', 3));
    const lead = await newLead(orgId);
    await callStepWent(orgId, lead.id, 'no_answer');
    await automation.markBooked(auth, lead.id, { note: 'Booked by phone' });
    await sleep(4 * SEC);
    expect(textsTo(lead.phone)).toEqual([]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('appointment_booked');
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { orgId, action: 'lead.marked_booked', entityId: lead.id } });
    expect(entry.payload).toEqual({ note: 'Booked by phone' });
  });
});

describe('an older three-step strategy', () => {
  const legacy = {
    steps: [
      { id: 's1', after: { value: 0, unit: 'seconds' }, channel: 'sms', message: 'Hi {{firstName}}' },
      { id: 's2', after: { value: 1, unit: 'seconds' }, channel: 'voice' },
      { id: 's3', after: { value: 3, unit: 'seconds' }, channel: 'sms', message: 'Just tried you' },
    ],
  };

  it('runs as it always has, timed from enrolment, and its saved form is never rewritten', async () => {
    const { orgId } = await setupOrg(legacy);
    const before = await prisma.organizationSetting.findUniqueOrThrow({ where: { orgId }, select: { outreachStrategy: true } });
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    await waitFor(() => dialsFor(lead.id).length, (n) => n === 1);
    await callHappened(orgId, lead.id, 'no_answer');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 3)).toEqual(['1:sent', '2:queued', '3:sent']);
    expect(textsTo(lead.phone).map((t) => t.text)).toEqual(['Hi Asha', 'Just tried you']);

    const after = await prisma.organizationSetting.findUniqueOrThrow({ where: { orgId }, select: { outreachStrategy: true } });
    expect(after.outreachStrategy).toEqual(before.outreachStrategy);
    const view = toTwoStep(await strategies.getStrategy(orgId));
    expect(view.converted).toBe(true);
    expect(view.steps.map((s) => [s.id, s.after])).toEqual([
      ['s1', { value: 0, unit: 'seconds' }],
      ['s2', { value: 1, unit: 'seconds' }],
    ]);
  });

  it('the safety rules still hold: after an answered call its last text does not go', async () => {
    const { orgId } = await setupOrg(legacy);
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    await waitFor(() => dialsFor(lead.id).length, (n) => n === 1);
    await callHappened(orgId, lead.id, 'answered');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 3)).toEqual(['1:sent', '2:queued', '3:skipped:call_answered']);
    expect(textsTo(lead.phone).length).toBe(1);
  });

  it('saving only the contact hours keeps it the older strategy', async () => {
    const { orgId } = await setupOrg(legacy);
    await strategies.saveStrategy(orgId, { guardrails: { ...guardrails, respectQuietHours: true } });
    const s = await strategies.getStrategy(orgId);
    expect(s.timing).toBeUndefined();
    expect(s.steps).toEqual(legacy.steps);
  });
});

describe('follow-up sequences', () => {
  async function sequence(orgId: string, code: string, steps: Record<string, unknown>[], triggers: string[] = []) {
    return prisma.sequence.create({ data: { orgId, code, name: code, steps: steps as Prisma.InputJsonArray, triggers: triggers as never } });
  }
  /** The runner's view of one enrolment, handed to it directly: no claim, so no other organization's rows are ever touched. */
  const runRow = async (enrollmentId: string) => {
    const e = await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
    await (runner as any).execute({ id: e.id, organization_id: e.orgId, lead_id: e.leadId, sequence_id: e.sequenceId, current_step: e.currentStep, attempts: 1, enrolled_at: e.enrolledAt });
  };

  it('"only if the last call was not answered": skipped after an answered call, sent after a missed one', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const steps = [
      { actionType: 'voice', delayMinutes: 60, messageTemplate: null, voicePrompt: 'Check in', maxAttempts: 1 },
      { actionType: 'sms', delayMinutes: 5, messageTemplate: 'Sorry we missed you', voicePrompt: null, maxAttempts: 1, condition: 'call_not_answered' },
      { actionType: 'sms', delayMinutes: 60, messageTemplate: 'Still looking?', voicePrompt: null, maxAttempts: 1 },
    ];
    const seq = await sequence(orgId, 'NURTURE', steps);

    for (const [kind, expected, sent] of [
      ['answered', '2:skipped:condition_not_met', 0],
      ['no_answer', '2:sent', 1],
    ] as const) {
      const lead = await newLead(orgId);
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'follow_up', followUpReason: 'no_answer', firstContactAt: new Date() } });
      const enrollment = await prisma.sequenceEnrollment.create({
        data: { orgId, leadId: lead.id, sequenceId: seq.id, currentStep: 2, status: 'active', nextActionAt: null, enrolledAt: new Date(Date.now() - 3_600_000) },
      });
      await callHappened(orgId, lead.id, kind);
      await runRow(enrollment.id);
      expect(await runsOf(lead.id)).toEqual([expected]);
      expect(textsTo(lead.phone).length).toBe(sent);
      expect((await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).currentStep).toBe(3);
    }
  });

  it('a new score moves a lead from its automatic sequence to the one the score points at', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const sms1 = [{ actionType: 'sms', delayMinutes: 60, messageTemplate: 'x', voicePrompt: null, maxAttempts: 1 }];
    const noAnswer = await sequence(orgId, 'NO_ANSWER', sms1, ['follow_up_no_answer']);
    const warm = await sequence(orgId, 'WARM', sms1, ['qualified_warm']);
    const lead = await newLead(orgId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'follow_up', followUpReason: 'no_answer', firstContactAt: new Date() } });
    await followup.enroll(orgId, lead.id, 'NO_ANSWER');

    await engine.qualified(orgId, lead.id, 'warm', 'WARM — 50.');
    const row = (sequenceId: string) => prisma.sequenceEnrollment.findFirstOrThrow({ where: { leadId: lead.id, sequenceId } });
    expect([(await row(noAnswer.id)).status, (await row(noAnswer.id)).stoppedReason]).toEqual(['stopped', 'rescored']);
    expect((await row(warm.id)).status).toBe('active');
    // Due far ahead, so no runner anywhere picks this suite's enrolment up before the organization is deleted.
    await prisma.sequenceEnrollment.updateMany({ where: { leadId: lead.id }, data: { nextActionAt: null } });
  });

  it('pause and resume from the lead: the enrolment pauses and picks up again, both audited', async () => {
    const { orgId, auth } = await twoStep(callThenSms('always'));
    const seq = await sequence(orgId, 'NURTURE2', [{ actionType: 'sms', delayMinutes: 60, messageTemplate: 'x', voicePrompt: null, maxAttempts: 1 }]);
    const lead = await newLead(orgId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'follow_up', followUpReason: 'not_ready', firstContactAt: new Date() } });
    const enrollment = await prisma.sequenceEnrollment.create({
      data: { orgId, leadId: lead.id, sequenceId: seq.id, currentStep: 1, status: 'active', nextActionAt: new Date(Date.now() + 86_400_000) },
    });

    await automation.setAutomation(auth, lead.id, { paused: true });
    expect((await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('paused');
    await automation.setAutomation(auth, lead.id, { paused: false });
    expect((await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('active');
    await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { nextActionAt: null } });
    expect(await prisma.auditLog.count({ where: { orgId, entityId: lead.id, action: { in: ['lead.automation_paused', 'lead.automation_resumed'] } } })).toBe(2);
  });
});

describe('review flags', () => {
  it('flag and clear touch only the reason given, and only on this organization’s lead', async () => {
    const a = await twoStep(callThenSms('always'));
    const b = await twoStep(callThenSms('always'));
    const lead = await newLead(a.orgId);
    await prisma.lead.update({ where: { id: lead.id }, data: { needsReview: true, reviewReasons: ['Phone could not be parsed'] } });

    await guard.flagReview(b.orgId, lead.id, 'from the wrong organization');
    await guard.flagReview(a.orgId, lead.id, 'Call needs a look');
    await guard.flagReview(a.orgId, lead.id, 'Call needs a look');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).reviewReasons).toEqual(['Phone could not be parsed', 'Call needs a look']);

    await guard.clearReview(a.orgId, lead.id, 'Call needs a look');
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect([after.needsReview, after.reviewReasons]).toEqual([true, ['Phone could not be parsed']]);
  });
});

describe('tenant isolation', () => {
  it('another organization can neither pause, resume nor book a lead, nor hold its steps with its own calls', async () => {
    const a = await twoStep(callThenSms('call_not_answered'));
    const b = await twoStep(callThenSms('call_not_answered'));
    const lead = await newLead(a.orgId);
    const theirs = await newLead(b.orgId);

    await expect(automation.setAutomation(b.auth, lead.id, { paused: true })).rejects.toThrow(/No such lead/);
    await expect(automation.markBooked(b.auth, lead.id, {})).rejects.toThrow(/No such lead/);
    expect(await prisma.auditLog.count({ where: { orgId: b.orgId, entityId: lead.id } })).toBe(0);

    // A live call on the other organization's lead holds nothing here.
    await prisma.call.create({ data: { orgId: b.orgId, leadId: theirs.id, status: 'in_progress', startedAt: new Date(), answeredAt: new Date() } });
    await callStepWent(a.orgId, lead.id, 'no_answer');
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:sent']);
  });
});

describe('strategy redesign: start after, waits from the call end, the "Only if" rules', () => {
  const onlyIf = (rules: unknown[], match = 'all') => ({ match, rules });

  it('step 1 "start after": nothing goes at once; the call goes once its time is up', async () => {
    const { orgId } = await twoStep([{ ...callThenSms('always')[0], after: { value: 3, unit: 'seconds' } }, callThenSms('always')[1]]);
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    await sleep(1_500);
    expect(dialsFor(lead.id)).toEqual([]);
    await waitFor(() => dialsFor(lead.id).length, (n) => n === 1);
    expect(dialsFor(lead.id).length).toBe(1);
  });

  it('the text after a call waits its time from when the call ended', async () => {
    const { orgId } = await twoStep(callThenSms('always', 2));
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    await waitFor(() => dialsFor(lead.id).length, (n) => n === 1);
    // The call rings for a second, then rings out: before step 2 is first due (2s after the call step), so the
    // guard never sees it live (it would look again only a minute later).
    const row = await prisma.call.create({ data: { orgId, leadId: lead.id, status: 'ringing', startedAt: new Date() } });
    await sleep(1_000);
    const endedAt = new Date();
    await prisma.call.update({ where: { id: row.id }, data: { status: 'no_answer', endedAt, endReason: 'timeout' } });
    await waitFor(() => runsOf(lead.id), (r) => r.length === 2, 10_000);
    const sent = await prisma.outreachStepRun.findFirstOrThrow({ where: { leadId: lead.id, stepNumber: 2 } });
    expect(sent.outcome).toBe('sent');
    expect(sent.createdAt.getTime() - endedAt.getTime()).toBeGreaterThanOrEqual(1_900);
  });

  it('"call result is busy/declined" goes after a busy line, and is skipped (with why) after no answer', async () => {
    const steps = callThenSms('always', 1);
    steps[1] = { ...steps[1], onlyIf: onlyIf([{ field: 'call_result', op: 'in', value: ['busy'] }]) as never };
    for (const [endReason, expected] of [
      ['user_busy', '2:sent'],
      ['timeout', '2:skipped:condition_not_met'],
    ]) {
      const { orgId } = await twoStep(steps);
      const lead = await newLead(orgId);
      await engine.enroll(orgId, lead.id);
      await waitFor(() => dialsFor(lead.id).length, (n) => n === 1);
      await prisma.call.create({ data: { orgId, leadId: lead.id, status: 'no_answer', startedAt: new Date(), endedAt: new Date(), endReason } });
      expect((await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).at(1)).toBe(expected);
      if (endReason === 'timeout') {
        const skipped = await prisma.outreachStepRun.findFirstOrThrow({ where: { leadId: lead.id, stepNumber: 2 } });
        expect(skipped.detail).toBe('The call result was no answer');
      }
    }
  });

  it('"call result is voicemail" goes when answering machine detection heard a machine', async () => {
    const steps = callThenSms('always', 1);
    steps[1] = { ...steps[1], onlyIf: onlyIf([{ field: 'call_result', op: 'in', value: ['voicemail'] }]) as never };
    const { orgId } = await twoStep(steps);
    const lead = await newLead(orgId);
    await engine.enroll(orgId, lead.id);
    await waitFor(() => dialsFor(lead.id).length, (n) => n === 1);
    const now = Date.now();
    await prisma.call.create({
      data: { orgId, leadId: lead.id, status: 'completed', startedAt: new Date(now - 60_000), answeredAt: new Date(now - 50_000), endedAt: new Date(now), answeredBy: 'machine' },
    });
    expect(await waitFor(() => runsOf(lead.id), (r) => r.length === 2)).toEqual(['1:queued', '2:sent']);
  });

  it('a saved "Only if" with a field that means nothing after a call is refused', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const steps = callThenSms('always');
    steps[1] = { ...steps[1], onlyIf: onlyIf([{ field: 'sms_reply', op: 'is', value: 'replied' }]) as never };
    await expect(strategies.saveStrategy(orgId, { steps })).rejects.toThrow(/cannot be used on this step/);
  });
});

describe('audit fixes against the real database', () => {
  it('D2: a lead closed as not interested who books is booked', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const lead = await newLead(orgId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'not_interested' } });
    await engine.appointmentBooked(orgId, lead.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('appointment_booked');
  });

  it('C2: "Yes" from a lead in outreach is a reply (paused), never an opt-in', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const lead = await newLead(orgId);
    const inbound = new InboundSmsService(prisma, { orgForNumber: async () => orgId } as never, followup);
    await inbound.onMessageReceived({ id: `in-${randomUUID()}`, from: { phone_number: lead.phone }, to: [{ phone_number: '+14155550000' }], text: 'Yes' });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect([after.automationPaused, after.consentSource]).toEqual([true, null]);
  });

  it('B11: Telnyx SIP 404 marks the lead invalid and keeps the reason on the call', async () => {
    const { orgId } = await twoStep(callThenSms('always'));
    const lead = await newLead(orgId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'contacting' } });
    const ccid = `cc-${randomUUID()}`;
    await prisma.call.create({ data: { orgId, leadId: lead.id, providerCallId: ccid, status: 'ringing', startedAt: new Date() } });
    await activity.onCallHangup(ccid, { hangup_cause: 'unspecified', sip_hangup_cause: '404' });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('invalid');
    expect((await prisma.call.findFirstOrThrow({ where: { providerCallId: ccid } })).endReason).toBe('not_found');
  });

  it('A4: a strategy call still queued after the lead left the strategy is never dialled', async () => {
    const { CallWorker } = await import('@/telnyx/calls/call.worker');
    const { orgId } = await twoStep(callThenSms('always'));
    const lead = await newLead(orgId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'follow_up', followUpReason: 'not_ready', firstContactAt: new Date() } });
    let placed = 0;
    const voice = {
      placeCall: async () => {
        placed += 1;
        return { call_control_id: 'never' };
      },
    };
    const slots = { acquire: async () => true, release: async () => undefined, rename: async () => undefined };
    const worker = new CallWorker(prisma, { get: () => undefined } as never, followup, voice as never, activity, slots as never);
    await worker.process({ id: 'job-a4', name: 'dial', data: { orgId, leadId: lead.id, source: 'strategy' } } as never, 'tok');
    expect(placed).toBe(0);
  });
});

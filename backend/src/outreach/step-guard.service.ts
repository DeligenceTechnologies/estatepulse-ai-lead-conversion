import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { CallStatus, LeadStatus, type Call } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import { CALL_QUEUE, callJobId } from '@/queue/queue.constants';
import { evaluate, onlyIfOf, skipDetail, usesField, type CallOutcome, type Facts, type OnlyIf } from './conditions';

const PENDING_JOB_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** Without an analysis, a picked-up call is a conversation from this many seconds of talk. */
export const MIN_ANSWERED_SECONDS = 30;
/**
 * How long a picked-up call waits for its analysis (which decides whether a person was reached).
 * Past it the talk time decides, and an answered call with no score flags the lead.
 */
export const SCORE_WAIT_MS = 15 * 60_000;
/** A row still ringing, or still in progress, past these never got its hang-up. */
export const RINGING_STALE_MS = 5 * 60_000;
export const IN_PROGRESS_STALE_MS = 30 * 60_000;
/**
 * A step waits for as long as the call before it is still in the queue (quiet hours, capacity, a
 * retry). Past a day it is given up on: the step is skipped with the reason and the lead flagged.
 */
export const QUEUED_CALL_MAX_WAIT_MS = 24 * 60 * 60_000;
/** How soon a held step looks again. */
export const RECHECK_MS = 60_000;
/** A queued call's row can be written a moment before its step run is. */
export const CALL_ROW_LEEWAY_MS = 30_000;

export const SCORE_MISSING_REVIEW = 'The call was answered, but no score came back within 15 minutes. Open the call to see how it went.';
export const CALLBACK_UNHANDLED_REVIEW = 'Asked for a callback, but no active sequence handles "Follow-up: Callback requested". Call them back.';
export const QUEUE_STUCK_REVIEW = 'A call to this lead waited in the call queue for over a day, so the next step was skipped. Check the calling setup.';

/** Why a step did not go, as stored on outreach_step_runs.reason. */
export type SkipReason =
  | 'booked'
  | 'call_answered'
  | 'max_voice_attempts'
  | 'call_unresolved'
  | 'call_still_queued'
  | 'condition_not_met'
  | 'safety_rule';

export interface StepRun {
  orgId: string;
  leadId: string;
  source: 'strategy' | 'followup';
  enrollmentId?: string | null;
  runKey: string;
  stepNumber: number;
  channel: 'sms' | 'voice';
  outcome: 'sent' | 'queued' | 'failed' | 'skipped';
  reason?: SkipReason | null;
  /** Why a skipped step did not go, in words the lead's page shows. */
  detail?: string | null;
  callKey?: string | null;
}

export interface Unmet {
  reason: SkipReason;
  detail?: string;
}

export type Hold =
  | { kind: 'go' }
  | { kind: 'wait'; until: number; reason: 'call_live' | 'call_queued' | 'awaiting_analysis' }
  | { kind: 'stuck' }
  | { kind: 'booked' }
  | { kind: 'answered'; call: { id: string; endedAt: Date | null } };

type CallRow = Pick<Call, 'id' | 'status' | 'createdAt' | 'startedAt' | 'answeredAt' | 'endedAt' | 'durationSeconds' | 'extractedIntel'> &
  Partial<Pick<Call, 'endReason' | 'answeredBy'>>;

export type CallResult = 'live' | 'awaiting_analysis' | 'answered' | 'not_answered' | 'failed';

const CONVERSATION_SIGNALS = ['appointment_requested', 'high_engagement', 'not_interested', 'invalid_lead', 'human_requested', 'callback_requested'] as const;

const qualificationOf = (call: Pick<Call, 'extractedIntel'>) =>
  (call.extractedIntel as { qualification?: { extraction?: Record<string, unknown> } } | null)?.qualification ?? null;

export const isScored = (call: Pick<Call, 'extractedIntel'>): boolean => qualificationOf(call) !== null;

/**
 * What a call amounts to, from its row alone, whichever provider placed it. Answered means a
 * person was reached. The call's analysis decides that when it has: a voicemail, a phone menu or
 * the agent talking alone is not answered however long it ran. Until the analysis comes (up to
 * SCORE_WAIT_MS after the hang-up) a call picked up (answered_at) is awaiting it; a call never
 * picked up — no answer, busy, ring timeout — is not answered at once. Without an analysis, a call is
 * answered from MIN_ANSWERED_SECONDS of talk. Busy and no answer are not answered; failed is the
 * provider never placing it. A row whose hang-up never arrived is taken as ended: one stuck
 * ringing as not answered, one stuck in progress as answered (someone picked up) unless the
 * analysis says otherwise.
 */
export function callResult(call: CallRow, now = Date.now()): CallResult {
  switch (call.status) {
    case CallStatus.failed:
      return 'failed';
    case CallStatus.no_answer:
      return 'not_answered';
    case CallStatus.completed: {
      const verdict = analysisVerdict(call);
      if (verdict !== null) return verdict ? 'answered' : 'not_answered';
      // Answering machine detection heard a machine: voicemail, decided now rather than after the analysis.
      if (call.answeredBy === 'machine') return 'not_answered';
      // Only a call someone picked up (answered_at) waits for its analysis; a row from before the column is judged by its time.
      if (!isScored(call) && call.answeredAt && now - (call.endedAt ?? call.createdAt).getTime() < SCORE_WAIT_MS) return 'awaiting_analysis';
      return talkedLongEnough(call) ? 'answered' : 'not_answered';
    }
    case CallStatus.in_progress:
      if (now - (call.answeredAt ?? call.startedAt ?? call.createdAt).getTime() <= IN_PROGRESS_STALE_MS) return 'live';
      return analysisVerdict(call) === false ? 'not_answered' : 'answered';
    default:
      return now - (call.startedAt ?? call.createdAt).getTime() > RINGING_STALE_MS ? 'not_answered' : 'live';
  }
}

/** Whether the analysis says a person was reached; null when there is none or it cannot tell (older analyses). */
function analysisVerdict(call: CallRow): boolean | null {
  const extraction = qualificationOf(call)?.extraction;
  if (!extraction) return null;
  if (typeof extraction.reached_person === 'boolean') return extraction.reached_person;
  return CONVERSATION_SIGNALS.some((key) => extraction[key] === true) ? true : null;
}

const BUSY_REASONS = new Set(['user_busy', 'call_rejected', 'dial_busy']);
const VOICEMAIL_REASONS = new Set(['voicemail_reached']);

/** The last call as an "Only if" rule reads it: how it went, in the owner's terms. */
export function callOutcomeOf(call: CallRow | null, now = Date.now()): CallOutcome {
  if (!call) return 'none';
  const result = callResult(call, now);
  if (result === 'live' || result === 'awaiting_analysis') return 'pending';
  if (result === 'failed') return 'failed';
  if (result === 'answered') return 'conversation';
  if (call.answeredBy === 'machine' || analysisVerdict(call) === false || VOICEMAIL_REASONS.has(call.endReason ?? '')) return 'voicemail';
  if (call.status === CallStatus.completed || call.status === CallStatus.in_progress) return 'short_pickup';
  return BUSY_REASONS.has(call.endReason ?? '') ? 'busy' : 'no_answer';
}

function talkedLongEnough(call: CallRow): boolean {
  // Rows from before answered_at existed only have the time from dialing, ring included.
  const talked =
    call.answeredAt && call.endedAt ? (call.endedAt.getTime() - call.answeredAt.getTime()) / 1000 : (call.durationSeconds ?? 0);
  return talked >= MIN_ANSWERED_SECONDS;
}

/**
 * The safety rules every strategy and sequence step passes before it goes, read from the
 * calls, step runs and meetings on record so they hold for any provider and across restarts:
 * nothing goes while a call is live or still queued, nothing after a meeting is booked, and an
 * answered call ends the strategy (its score decides what follows). Also keeps the step-run
 * record and the review flags the owner sees.
 */
@Injectable()
export class StepGuard {
  private readonly logger = new Logger(StepGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CALL_QUEUE) private readonly callQueue: Queue,
  ) {}

  /** `since` is when the lead entered this strategy run or enrolment; `endOnAnswer` is the strategy's rule. */
  async check(input: { orgId: string; leadId: string; since: Date; endOnAnswer: boolean }): Promise<Hold> {
    const { orgId, leadId, since } = input;
    const now = Date.now();
    if (await this.hasUpcomingMeeting(orgId, leadId, now)) return { kind: 'booked' };

    const calls = await this.recentCalls(orgId, leadId, since, now);
    if (calls.some((c) => callResult(c, now) === 'live')) return { kind: 'wait', until: now + RECHECK_MS, reason: 'call_live' };
    const queued = await this.queuedCall(orgId, leadId, calls, now);
    if (queued === 'pending') return { kind: 'wait', until: now + RECHECK_MS, reason: 'call_queued' };
    if (queued === 'stuck') {
      await this.flagReview(orgId, leadId, QUEUE_STUCK_REVIEW);
      return { kind: 'stuck' };
    }
    if (calls.some((c) => callResult(c, now) === 'awaiting_analysis')) return { kind: 'wait', until: now + RECHECK_MS, reason: 'awaiting_analysis' };

    const answered = calls.find((c) => c.createdAt >= since && callResult(c, now) === 'answered');
    if (!answered) return { kind: 'go' };
    if (input.endOnAnswer) return { kind: 'answered', call: { id: answered.id, endedAt: answered.endedAt } };
    // Answered by its talk time alone: the wait for its analysis is over and none came.
    if (!isScored(answered)) await this.flagReview(orgId, leadId, SCORE_MISSING_REVIEW);
    return { kind: 'go' };
  }

  /**
   * Why the step's "Only if" holds it back, or null when it may go. Takes the rule set, or an older
   * single condition (mapped, nothing rewritten). "The last call" is the call since `callsSince`
   * (default `since`; null = the lead's last call ever); a reply counts from `since`. A call that
   * never connected or was never placed is never "not answered".
   */
  async conditionUnmet(
    condition: OnlyIf | string | null | undefined,
    input: { orgId: string; leadId: string; since: Date; callsSince?: Date | null },
  ): Promise<Unmet | null> {
    const onlyIf = condition && typeof condition === 'object' ? condition : onlyIfOf({ condition: condition ?? null });
    if (!onlyIf.rules.length) return null;
    const facts = await this.factsFor(onlyIf, input);
    if (facts.callOutcome === 'pending' && usesField(onlyIf, 'call_result')) return { reason: 'call_unresolved', detail: 'The call had not finished' };
    const verdict = evaluate(onlyIf, facts);
    return verdict.ok ? null : { reason: 'condition_not_met', detail: skipDetail(verdict.because, facts) };
  }

  /** When the strategy's last call (since `since`) ended: the step after a call waits from then. */
  async lastCallEndedAt(orgId: string, leadId: string, since: Date): Promise<Date | null> {
    const call = await this.prisma.call.findFirst({
      where: { orgId, leadId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { endedAt: true },
    });
    return call?.endedAt ?? null;
  }

  private async factsFor(onlyIf: OnlyIf, input: { orgId: string; leadId: string; since: Date; callsSince?: Date | null }): Promise<Facts> {
    const { orgId, leadId, since } = input;
    const facts: Facts = { callOutcome: 'none', smsReply: 'not_replied' };
    if (usesField(onlyIf, 'call_result')) {
      const callsSince = input.callsSince === undefined ? since : input.callsSince;
      const last = await this.prisma.call.findFirst({
        where: { orgId, leadId, ...(callsSince ? { createdAt: { gte: callsSince } } : {}) },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, startedAt: true, answeredAt: true, endedAt: true, durationSeconds: true, extractedIntel: true, endReason: true, answeredBy: true },
      });
      facts.callOutcome = callOutcomeOf(last);
    }
    if (usesField(onlyIf, 'sms_reply')) {
      const replies = await this.prisma.message.count({ where: { orgId, leadId, direction: 'inbound', createdAt: { gte: since } } });
      facts.smsReply = replies > 0 ? 'replied' : 'not_replied';
    }
    return facts;
  }

  /** When this strategy run last ran or skipped a step: a two-step strategy's next wait counts from it. */
  async lastRunAt(leadId: string, runKeyPrefix: string): Promise<Date | null> {
    const run = await this.prisma.outreachStepRun.findFirst({
      where: { leadId, runKey: { startsWith: runKeyPrefix } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return run?.createdAt ?? null;
  }

  async isScoredCall(orgId: string, callId: string): Promise<boolean> {
    const call = await this.prisma.call.findFirst({ where: { id: callId, orgId }, select: { extractedIntel: true } });
    return call ? isScored(call) : false;
  }

  /** A sequence step found a meeting on the calendar: the lead is booked, from any status but invalid (the strategy does this through the engine). */
  async markBooked(orgId: string, leadId: string): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: leadId, orgId, status: { notIn: [LeadStatus.invalid, LeadStatus.appointment_booked] } },
      data: { status: LeadStatus.appointment_booked },
    });
  }

  /** Bookkeeping only: a lost record never stops or repeats a step. */
  async record(run: StepRun): Promise<void> {
    await this.prisma.outreachStepRun
      .createMany({
        data: [
          {
            orgId: run.orgId,
            leadId: run.leadId,
            source: run.source,
            enrollmentId: run.enrollmentId ?? null,
            runKey: run.runKey,
            stepNumber: run.stepNumber,
            channel: run.channel,
            outcome: run.outcome,
            reason: run.reason ?? null,
            detail: run.detail?.slice(0, 300) ?? null,
            callKey: run.callKey ?? null,
          },
        ],
        skipDuplicates: true,
      })
      .catch((error) => this.logger.warn(`step run ${run.runKey} for lead ${run.leadId}: ${(error as Error).message}`));
  }

  async flagReview(orgId: string, leadId: string, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE leads SET needs_review = true, review_reasons = array_append(review_reasons, ${reason}), updated_at = now()
       WHERE id = ${leadId}::uuid AND organization_id = ${orgId}::uuid AND NOT (${reason} = ANY(review_reasons))`;
  }

  async clearReview(orgId: string, leadId: string, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE leads SET review_reasons = array_remove(review_reasons, ${reason}),
                       needs_review = cardinality(array_remove(review_reasons, ${reason})) > 0, updated_at = now()
       WHERE id = ${leadId}::uuid AND organization_id = ${orgId}::uuid AND ${reason} = ANY(review_reasons)`;
  }

  private hasUpcomingMeeting(orgId: string, leadId: string, now: number): Promise<boolean> {
    return this.prisma.calendarMeeting
      .count({ where: { orgId, leadId, status: 'scheduled', endsAt: { gt: new Date(now) } } })
      .then((n) => n > 0);
  }

  /** This run's calls, plus any from just before it that could still be live. Newest first. */
  private recentCalls(orgId: string, leadId: string, since: Date, now: number): Promise<CallRow[]> {
    const from = new Date(Math.min(since.getTime(), now - IN_PROGRESS_STALE_MS));
    return this.prisma.call.findMany({
      where: { orgId, leadId, createdAt: { gte: from } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, status: true, createdAt: true, startedAt: true, answeredAt: true, endedAt: true, durationSeconds: true, extractedIntel: true, endReason: true, answeredBy: true },
    });
  }

  /** The call queued under this key has not been dialed or dropped yet. */
  private async isPending(callKey: string): Promise<boolean> {
    const job = await this.callQueue.getJob(callJobId(callKey));
    return job ? PENDING_JOB_STATES.has(await job.getState()) : false;
  }

  /**
   * A call step whose call has no row yet: 'pending' while its job still waits in the queue,
   * 'stuck' once it has waited longer than QUEUED_CALL_MAX_WAIT_MS. A job that left the queue
   * without a row (dropped, failed for good) holds nothing. When the queue cannot be read, the
   * job is taken as still waiting.
   */
  private async queuedCall(orgId: string, leadId: string, calls: CallRow[], now: number): Promise<'none' | 'pending' | 'stuck'> {
    const queued = await this.prisma.outreachStepRun.findMany({
      where: { orgId, leadId, outcome: 'queued', createdAt: { gte: new Date(now - 2 * QUEUED_CALL_MAX_WAIT_MS) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { callKey: true, createdAt: true },
    });
    for (const run of queued) {
      if (!run.callKey || calls.some((c) => c.createdAt.getTime() >= run.createdAt.getTime() - CALL_ROW_LEEWAY_MS)) continue;
      if (!(await this.isPending(run.callKey).catch(() => true))) continue;
      return now - run.createdAt.getTime() > QUEUED_CALL_MAX_WAIT_MS ? 'stuck' : 'pending';
    }
    return 'none';
  }
}


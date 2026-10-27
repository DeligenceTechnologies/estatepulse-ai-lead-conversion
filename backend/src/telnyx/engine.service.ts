import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { ConsentStatus, FollowUpReason, LeadStatus, type LeadTemperature, type SequenceTrigger } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { deferredResume, inQuietHours, nextAllowedAt, type QuietHours } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { INACTIVE_STATUSES, IN_STRATEGY_STATUSES, OUTCOME_STATUSES } from '@/lead/lead-status';
import { ActivityService } from './activity.service';
import { SmsService } from './sms.service';
import { StrategyStoreService, isTwoStep, offsetMs, type StrategyStep } from './strategy-store.service';
import { CallQueue } from './calls/call.queue';
import { onlyIfOf } from '@/outreach/conditions';
import { leadStop } from '@/outreach/safety-rules';
import { CALLBACK_UNHANDLED_REVIEW, SCORE_MISSING_REVIEW, SCORE_WAIT_MS, StepGuard, type SkipReason, type StepRun, type Unmet } from '@/outreach/step-guard.service';

const FINALIZE_AFTER_MS = 90_000;

/**
 * Which steps are still to run after a restart, matched against the calls and
 * texts already on record, and the anchor that keeps their spacing.
 */
export function remainingSteps(
  steps: StrategyStep[],
  callsOnRecord: number,
  textsOnRecord: number,
  enrolledAt: number,
  now: number,
): { remaining: StrategyStep[]; anchor: number } {
  let calls = callsOnRecord;
  let texts = textsOnRecord;
  const remaining = steps.filter((s) => {
    if (s.channel === 'voice') {
      if (calls === 0) return true;
      calls -= 1;
      return false;
    }
    if (texts === 0) return true;
    texts -= 1;
    return false;
  });
  const first = remaining.at(0);
  const lag = first ? Math.max(0, now - (enrolledAt + offsetMs(first.after))) : 0;
  return { remaining, anchor: enrolledAt + lag };
}

interface Guardrails {
  respectQuietHours?: boolean;
  quietHours?: QuietHours;
  maxVoiceAttempts?: number;
}

/** A step still to run, with its 1-based place in the strategy and the channel of the step before it. */
interface PlannedStep {
  step: StrategyStep;
  number: number;
  follows?: StrategyStep['channel'];
}

const planOf = (steps: StrategyStep[], only: StrategyStep[] = steps): PlannedStep[] =>
  only.map((step) => {
    const i = steps.indexOf(step);
    return { step, number: i + 1, follows: steps[i - 1]?.channel };
  });

interface Enrollment {
  orgId: string;
  leadId: string;
  voiceAttempts: number;
  timers: NodeJS.Timeout[];
  stopped: boolean;
  ran: number;
  total: number;
  enrolledAt: number;
  quietShift: number;
  /** first_contact_at: names this run in the step record and bounds which calls belong to it. */
  startedAt: Date;
  plan: PlannedStep[];
  /** A two-step strategy: each wait counts from when the step before it ran (lastRanAt), not from enrolment. */
  afterPrevious: boolean;
  lastRanAt: number;
  brokerage: string;
  timeZone: string;
  guardrails: Guardrails;
}

/**
 * Runs the outreach strategy for each new lead: the configured SMS and AI call
 * steps on their schedule, one after the other, held back during quiet hours
 * and while a call is live or still queued, stopped the moment the lead
 * replies, books, opts out, reaches any outcome or answers a call (its score
 * decides what follows). Enrolment is claimed in the database
 * (first_contact_at), so only one instance ever runs a lead; in-flight leads
 * are resumed after a restart by LeadWatcherService.
 */
@Injectable()
export class EngineService implements OnModuleDestroy {
  private readonly logger = new Logger('Engine');
  private readonly active = new Map<string, Enrollment>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategies: StrategyStoreService,
    private readonly sms: SmsService,
    private readonly calls: CallQueue,
    private readonly activity: ActivityService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly guard: StepGuard,
  ) {}

  onModuleDestroy(): void {
    for (const enrollment of this.active.values()) this.halt(enrollment);
    this.active.clear();
  }

  async enroll(orgId: string, leadId: string): Promise<void> {
    if (this.active.has(leadId)) return;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId } });
    if (!lead || lead.dncStatus || lead.automationPaused) return;
    const startedAt = new Date();
    // The claim and the status move commit together, so a failed status update never leaves a claimed lead stuck in `new`.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.lead.updateMany({ where: { id: leadId, firstContactAt: null }, data: { firstContactAt: startedAt } });
      if (claim.count === 0) return false;
      await tx.lead.updateMany({ where: { id: leadId, status: LeadStatus.new }, data: { status: LeadStatus.contacting } });
      return true;
    });
    if (!claimed) return;

    const [strategy, office] = await Promise.all([this.strategies.getStrategy(orgId), this.office(orgId)]);
    const enrollment: Enrollment = {
      orgId,
      leadId,
      voiceAttempts: 0,
      timers: [],
      stopped: false,
      ran: 0,
      total: strategy.steps.length,
      enrolledAt: Date.now(),
      quietShift: 0,
      startedAt,
      plan: planOf(strategy.steps),
      afterPrevious: isTwoStep(strategy),
      lastRanAt: startedAt.getTime(),
      brokerage: office.brokerage,
      timeZone: office.timeZone,
      guardrails: strategy.guardrails as Guardrails,
    };
    this.active.set(leadId, enrollment);
    this.logger.log(`enrolled lead ${leadId} into "${strategy.name}" — ${strategy.steps.length} steps`);
    this.scheduleNext(enrollment);
  }

  /** Picks a lead back up after a restart, skipping the steps already taken. */
  async resume(orgId: string, leadId: string): Promise<boolean> {
    if (this.active.has(leadId)) return false;
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId },
      select: { firstContactAt: true, status: true, dncStatus: true, automationPaused: true },
    });
    if (!lead?.firstContactAt || lead.dncStatus || lead.automationPaused || !IN_STRATEGY_STATUSES.includes(lead.status)) return false;

    const [calls, texts, strategy, office] = await Promise.all([
      this.prisma.call.count({ where: { orgId, leadId } }),
      this.prisma.message.count({ where: { orgId, leadId, direction: 'outbound', channel: 'sms' } }),
      this.strategies.getStrategy(orgId),
      this.office(orgId),
    ]);
    const { remaining, anchor } = remainingSteps(strategy.steps, calls, texts, lead.firstContactAt.getTime(), Date.now());
    const lastRun = isTwoStep(strategy) ? await this.guard.lastRunAt(leadId, `strategy:${lead.firstContactAt.getTime()}:`) : null;
    const enrollment: Enrollment = {
      orgId,
      leadId,
      voiceAttempts: calls,
      timers: [],
      stopped: false,
      ran: strategy.steps.length - remaining.length,
      total: strategy.steps.length,
      enrolledAt: anchor,
      quietShift: 0,
      startedAt: lead.firstContactAt,
      plan: planOf(strategy.steps, remaining),
      afterPrevious: isTwoStep(strategy),
      lastRanAt: (lastRun ?? lead.firstContactAt).getTime(),
      brokerage: office.brokerage,
      timeZone: office.timeZone,
      guardrails: strategy.guardrails as Guardrails,
    };
    this.active.set(leadId, enrollment);
    this.logger.log(`resumed lead ${leadId} — ${remaining.length} of ${enrollment.total} step(s) left`);
    this.scheduleNext(enrollment);
    return true;
  }

  /** A lead whose strategy was interrupted for longer than it could resume is parked for follow-up. */
  async finalizeAbandoned(orgId: string, leadId: string): Promise<boolean> {
    if (this.active.has(leadId)) return false;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { status: true, dncStatus: true, aiSummary: true } });
    if (!lead || OUTCOME_STATUSES.includes(lead.status) || lead.dncStatus) return false;
    await this.activity.exitStrategy(leadId, `Strategy interrupted — ${lead.aiSummary || 'recovered after a restart'}`.slice(0, 2000));
    await this.enrolOnFollowUp(orgId, leadId);
    return true;
  }

  /** The call scored the lead: hot goes to an agent, anything else to follow-up, with the nurture sequence that claims it. */
  async qualified(
    orgId: string,
    leadId: string,
    temperature: LeadTemperature,
    summary?: string,
    opts: { callbackRequested?: boolean } = {},
  ): Promise<void> {
    const isHot = temperature === 'hot';
    let reason: FollowUpReason = FollowUpReason.not_ready;
    if (!isHot) {
      const current = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { status: true, followUpReason: true } });
      const askedBefore = current?.status === LeadStatus.follow_up && current.followUpReason === FollowUpReason.callback_requested;
      if (opts.callbackRequested || askedBefore) reason = FollowUpReason.callback_requested;
    }
    const updated = await this.prisma.lead.updateMany({
      where: { id: leadId, orgId },
      data: {
        ...(isHot ? { status: LeadStatus.interested } : { status: LeadStatus.follow_up, followUpReason: reason }),
        temperature,
        ...(summary ? { aiSummary: summary } : {}),
      },
    });
    if (updated.count === 0) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    this.stopFor(leadId);

    try {
      await this.guard.clearReview(orgId, leadId, SCORE_MISSING_REVIEW);
      // A hot lead goes to an agent: no sequence would ever send to it (interested is an outcome).
      const code = isHot
        ? undefined
        : ((await this.followup.sequenceForTrigger(orgId, `follow_up_${reason}` as SequenceTrigger)) ??
          (await this.followup.sequenceForTrigger(orgId, `qualified_${temperature}` as SequenceTrigger)));
      if (code) await this.enrolOrSwap(orgId, leadId, code);
      else if (reason === FollowUpReason.callback_requested && !isHot && !(await this.followup.liveEnrollment(orgId, leadId))) {
        await this.guard.flagReview(orgId, leadId, CALLBACK_UNHANDLED_REVIEW);
      }
    } catch (error) {
      this.logger.error(`auto-enrol ${leadId} (${temperature}): ${(error as Error).message}`);
    }
  }

  /** A booking wins from any status — a sequence that ran out, an opt-out from texts — except a wrong number. */
  async appointmentBooked(orgId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId } });
    if (!lead || lead.status === LeadStatus.invalid) return;
    if (lead.status !== LeadStatus.appointment_booked) {
      await this.prisma.lead.update({ where: { id: leadId }, data: { status: LeadStatus.appointment_booked } });
    }
    if (this.active.has(leadId)) {
      this.stopFor(leadId);
      await this.activity.exitStrategy(leadId, 'Appointment booked — strategy stopped');
    }
    await this.followup.stopForLead(orgId, leadId, 'appointment_booked');
  }

  async setStatus(
    orgId: string,
    leadId: string,
    status: LeadStatus,
    reason?: string,
    opts: { followUpReason?: FollowUpReason; optOut?: boolean } = {},
  ): Promise<void> {
    const optOut = Boolean(opts.optOut) && status === LeadStatus.not_interested;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { id: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    // An opt-out sets DNC and stops the sequences together: never one without the other.
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          status,
          ...(reason ? { aiSummary: reason.slice(0, 2000) } : {}),
          ...(status === LeadStatus.follow_up ? { followUpReason: opts.followUpReason ?? FollowUpReason.other } : {}),
          ...(optOut ? { dncStatus: true, automationPaused: true, consentStatus: ConsentStatus.revoked } : {}),
          ...(INACTIVE_STATUSES.includes(status) && reason ? { lostReason: reason.slice(0, 255) } : {}),
        },
      });
      if (optOut) await this.followup.stopForLead(orgId, leadId, 'opted_out', tx);
    });
    if (!IN_STRATEGY_STATUSES.includes(status)) this.stopFor(leadId);
    if (status === LeadStatus.follow_up) await this.enrolOnFollowUp(orgId, leadId);
  }

  /**
   * The owner's switch for one lead. Pausing holds the strategy and any sequence; resuming picks
   * them up where they were. A lead that opted out, or whose outreach never started (an import
   * waiting on approval, say), cannot be resumed here.
   */
  async setAutomationPaused(orgId: string, leadId: string, paused: boolean): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { dncStatus: true, firstContactAt: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    if (!paused && lead.dncStatus) throw new AppError('CONFLICT', 'This lead opted out, so automation stays off.');
    if (!paused && !lead.firstContactAt) throw new AppError('CONFLICT', 'Outreach has not started for this lead yet. Use Start AI Outreach instead.');
    await this.prisma.lead.update({ where: { id: leadId }, data: { automationPaused: paused } });
    if (paused) {
      this.stopFor(leadId);
      await this.followup.pauseForLead(orgId, leadId);
      return;
    }
    await this.followup.resumeForLead(orgId, leadId);
    await this.resume(orgId, leadId);
  }

  /** A meeting set outside the app (by phone, in person): booked, and every automated step stops. */
  async markBooked(orgId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { status: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    if (lead.status === LeadStatus.invalid) throw new AppError('CONFLICT', 'This lead is marked invalid (a wrong number), so it cannot be marked as booked.');
    await this.appointmentBooked(orgId, leadId);
  }

  /**
   * A call that ended the journey (not interested, wrong number): the lead is closed with the reason,
   * the strategy stops and so does every sequence. Nothing enrols it again.
   */
  async endJourney(orgId: string, leadId: string, status: LeadStatus, reason: string): Promise<void> {
    await this.setStatus(orgId, leadId, status, reason);
    await this.followup.stopForLead(orgId, leadId, `lead_${status}`);
    await this.guard.clearReview(orgId, leadId, SCORE_MISSING_REVIEW).catch(() => undefined);
  }

  isRunning(leadId: string): boolean {
    return this.active.has(leadId);
  }

  /**
   * Steps run in order. A two-step strategy's next step waits its time after the step before it
   * ran; an older strategy's is timed from enrolment, pushed back by however long quiet hours held
   * the cadence.
   */
  private scheduleNext(e: Enrollment): void {
    const next = e.plan[0];
    if (!next) return this.scheduleFinalize(e);
    const due = e.afterPrevious ? e.lastRanAt + offsetMs(next.step.after) : e.enrolledAt + offsetMs(next.step.after) + e.quietShift;
    this.later(e, () => this.fireStep(e, next), due - Date.now());
  }

  private async fireStep(e: Enrollment, item: PlannedStep): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
    if (!lead || leadStop(lead)) return this.stop(e);

    const { guardrails, timeZone } = e;
    if (guardrails?.respectQuietHours !== false && inQuietHours(timeZone, guardrails?.quietHours)) {
      const now = Date.now();
      if (e.afterPrevious) {
        this.later(e, () => this.fireStep(e, item), nextAllowedAt(timeZone, guardrails.quietHours, new Date(now)).getTime() - now);
        return;
      }
      const { shift, resumeAt } = deferredResume({
        timeZone,
        quiet: guardrails.quietHours,
        now,
        enrolledAt: e.enrolledAt,
        offset: offsetMs(item.step.after),
        shift: e.quietShift,
      });
      e.quietShift = shift;
      this.later(e, () => this.fireStep(e, item), resumeAt - now);
      return;
    }

    const hold = await this.guard.check({ orgId: e.orgId, leadId: e.leadId, since: e.startedAt, endOnAnswer: true });
    if (hold.kind === 'wait') return this.later(e, () => this.fireStep(e, item), hold.until - Date.now());
    if (hold.kind === 'booked') {
      await this.skip(e, item, 'booked');
      return this.appointmentBooked(e.orgId, e.leadId);
    }
    if (hold.kind === 'answered') {
      for (const rest of e.plan) await this.skip(e, rest, 'call_answered');
      e.plan = [];
      return this.awaitScore(e, hold.call);
    }

    // The step after a call waits its time from when that call ended.
    if (e.afterPrevious && item.follows === 'voice' && hold.kind === 'go') {
      const ended = await this.guard.lastCallEndedAt(e.orgId, e.leadId, e.startedAt);
      const due = ended ? ended.getTime() + offsetMs(item.step.after) : 0;
      if (due > Date.now()) return this.later(e, () => this.fireStep(e, item), due - Date.now());
    }

    const unmet: Unmet | null =
      hold.kind === 'stuck'
        ? { reason: 'call_still_queued' }
        : await this.guard.conditionUnmet(onlyIfOf(item.step), { orgId: e.orgId, leadId: e.leadId, since: e.startedAt });
    if (unmet) await this.skip(e, item, unmet.reason, unmet.detail);
    else await this.run(e, item, lead);
    e.plan.shift();
    e.ran += 1;
    e.lastRanAt = Date.now();
    this.scheduleNext(e);
  }

  private async run(e: Enrollment, item: PlannedStep, lead: { firstName: string | null; phone: string | null }): Promise<void> {
    const { step } = item;
    const firstName = lead.firstName?.trim() || 'there';
    if (step.channel === 'sms') {
      const text = (step.message ?? '').replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{brokerage\}\}/g, e.brokerage);
      try {
        const sent = await this.sms.sendSms(e.orgId, lead.phone ?? '', text);
        await this.activity.recordSms(e.orgId, e.leadId, text, true, sent.id);
        await this.guard.record(this.runOf(e, item, 'sent'));
      } catch (error) {
        await this.activity.recordSms(e.orgId, e.leadId, text, false, (error as Error).message);
        await this.guard.record(this.runOf(e, item, 'failed'));
      }
    } else if (step.channel === 'voice' && (e.guardrails?.maxVoiceAttempts ?? 99) > e.voiceAttempts) {
      e.voiceAttempts += 1;
      const dedupeKey = `strategy:${e.leadId}:${e.enrolledAt}:${e.voiceAttempts}`;
      try {
        await this.calls.enqueue({ orgId: e.orgId, leadId: e.leadId, source: 'strategy' }, { dedupeKey });
        await this.guard.record({ ...this.runOf(e, item, 'queued'), callKey: dedupeKey });
      } catch (error) {
        await this.activity.recordCallFailed(e.orgId, e.leadId, (error as Error).message);
        await this.guard.record(this.runOf(e, item, 'failed'));
      }
    } else if (step.channel === 'voice') {
      await this.skip(e, item, 'max_voice_attempts');
    }
  }

  private skip(e: Enrollment, item: PlannedStep, reason: SkipReason, detail?: string): Promise<void> {
    return this.guard.record({ ...this.runOf(e, item, 'skipped'), reason, detail });
  }

  private runOf(e: Enrollment, item: PlannedStep, outcome: StepRun['outcome']): StepRun {
    return {
      orgId: e.orgId,
      leadId: e.leadId,
      source: 'strategy',
      runKey: `strategy:${e.startedAt.getTime()}:${item.number}`,
      stepNumber: item.number,
      channel: item.step.channel,
      outcome,
    };
  }

  /** An answered call ended the strategy: its score moves the lead on; without one in time, a person is asked to look. */
  private awaitScore(e: Enrollment, call: { id: string; endedAt: Date | null }): void {
    this.logger.log(`lead ${e.leadId} answered a call — strategy ends, waiting for the call's score`);
    const deadline = (call.endedAt?.getTime() ?? Date.now()) + SCORE_WAIT_MS;
    this.later(e, () => this.scoreOverdue(e, call.id), deadline - Date.now());
  }

  private async scoreOverdue(e: Enrollment, callId: string): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId }, select: { status: true, dncStatus: true } });
    if (lead && IN_STRATEGY_STATUSES.includes(lead.status) && !lead.dncStatus) {
      const scored = await this.guard.isScoredCall(e.orgId, callId);
      if (!scored) await this.guard.flagReview(e.orgId, e.leadId, SCORE_MISSING_REVIEW);
      await this.activity.exitStrategy(e.leadId, scored ? 'Call answered — strategy ended' : 'Call answered — no score came back; needs a look');
      await this.enrolOnFollowUp(e.orgId, e.leadId);
    }
    this.stop(e);
  }

  private scheduleFinalize(e: Enrollment): void {
    this.later(e, () => this.finalize(e), FINALIZE_AFTER_MS);
  }

  /** After the last step: a call still live, queued or awaiting its analysis holds the exit; an answered one waits for its score. */
  private async finalize(e: Enrollment): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
    if (lead && !OUTCOME_STATUSES.includes(lead.status) && !lead.dncStatus) {
      const hold = await this.guard.check({ orgId: e.orgId, leadId: e.leadId, since: e.startedAt, endOnAnswer: true });
      if (hold.kind === 'wait') return this.later(e, () => this.finalize(e), hold.until - Date.now());
      if (hold.kind === 'booked') return this.appointmentBooked(e.orgId, e.leadId);
      if (hold.kind === 'answered') return this.awaitScore(e, hold.call);
      await this.activity.exitStrategy(e.leadId, `Strategy complete after ${e.total} step(s) — ${lead.aiSummary || 'lead not converted'}`.slice(0, 2000));
      await this.enrolOnFollowUp(e.orgId, e.leadId);
    }
    this.stop(e);
  }

  private async enrolOnFollowUp(orgId: string, leadId: string): Promise<void> {
    try {
      const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { status: true, followUpReason: true } });
      if (lead?.status !== LeadStatus.follow_up || !lead.followUpReason) return;
      const code = await this.followup.sequenceForTrigger(orgId, `follow_up_${lead.followUpReason}` as SequenceTrigger);
      if (code) await this.followup.enroll(orgId, leadId, code);
    } catch (error) {
      this.logger.error(`follow-up enrol ${leadId}: ${(error as Error).message}`);
    }
  }

  /**
   * A new score moves the lead to the sequence it now belongs in. Only an automatic enrolment is
   * swapped: one already in the right sequence carries on, and one an owner chose is left alone.
   */
  private async enrolOrSwap(orgId: string, leadId: string, code: string): Promise<void> {
    const live = await this.followup.liveEnrollment(orgId, leadId);
    if (live && (live.sequence.code === code || live.enrolledBy !== 'auto')) return;
    if (live) await this.followup.stopForLead(orgId, leadId, 'rescored');
    await this.followup.enroll(orgId, leadId, code);
  }

  private later(e: Enrollment, run: () => Promise<void>, delayMs: number): void {
    const timer = setTimeout(() => {
      run().catch((error) => this.logger.error(`lead ${e.leadId}: ${(error as Error).message}`));
    }, Math.max(0, delayMs));
    timer.unref();
    e.timers.push(timer);
  }

  private stopFor(leadId: string): void {
    const e = this.active.get(leadId);
    if (e) this.stop(e);
  }

  private stop(e: Enrollment): void {
    this.halt(e);
    this.active.delete(e.leadId);
  }

  private halt(e: Enrollment): void {
    e.stopped = true;
    e.timers.forEach(clearTimeout);
  }

  private async office(orgId: string): Promise<{ brokerage: string; timeZone: string }> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, settings: { select: { timezone: true } } } });
    return { brokerage: org?.name ?? 'our team', timeZone: org?.settings?.timezone ?? 'UTC' };
  }
}

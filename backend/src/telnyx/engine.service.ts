import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { CallDisposition, CallStatus, ConsentStatus, FollowUpReason, LeadStatus, type LeadTemperature, type SequenceTrigger } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { nextContactAt, type QuietHours } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { skipDaysOf, unmetCondition } from '@/followup/journey';
import { LeadStateService, type Actor } from '@/lead/lead-state.service';
import { INACTIVE_STATUSES, IN_STRATEGY_STATUSES, OUTCOME_STATUSES, callbackPending } from '@/lead/lead-status';
import { hasUpcomingMeeting } from '@/lead/upcoming-meeting';
import { ActivityService } from './activity.service';
import { CallingProviders, SMS_UNAVAILABLE } from '@/calling/calling-providers';
import { StrategyStoreService, offsetMs, stepOffsets, type StrategyStep } from './strategy-store.service';
import { CallQueue } from './calls/call.queue';
import { CONVERSATION_MIN_SECS } from './calls/call.types';
import { SmsConversationService } from './sms/sms-conversation.service';
import { fillTemplate } from './template';

const FINALIZE_AFTER_MS = 90_000;
/** A step held behind an open call looks again this often, and goes ahead anyway after the longest hold. */
const CALL_HOLD_RECHECK_MS = 30_000;
const CALL_HOLD_MAX_MS = 30 * 60_000;
/** How long the strategy waits for a conversation to be scored before closing on its own. */
const SCORING_WAIT_MS = 10 * 60_000;

/** However short a call step's wait, a text chat must have been quiet this long before the call. */
const MIN_CHAT_QUIET_MS = 2 * 60_000;

/** The longest wait one timer can hold (~24.8 days); a longer one is taken in pieces. */
const MAX_TIMER_MS = 2_147_483_647;
/** A step that throws is tried again after this, doubling each time up to the cap; past the last try the lead is parked. */
export const STEP_RETRY_BASE_MS = 10_000;
export const STEP_RETRY_MAX_MS = 5 * 60_000;
export const MAX_STEP_FAILURES = 5;
/** The review flag on a lead whose strategy was parked because a step kept failing. */
export const STEP_FAILED_REVIEW = 'Outreach stopped: a strategy step kept failing';

const OPEN_CALL: CallStatus[] = [CallStatus.queued, CallStatus.ringing, CallStatus.in_progress];

/**
 * Which steps are still to run after a restart, and when the first of them is
 * due. The steps the strategy logged as run (sent, skipped or failed) are
 * matched by id; a lead from before that log existed is matched against the
 * calls and texts on record instead.
 */
export function remainingSteps(
  steps: StrategyStep[],
  done: { stepIds: ReadonlySet<string>; calls: number; texts: number },
  enrolledAt: number,
): { remaining: StrategyStep[]; dueAt: number } {
  const offsets = stepOffsets(steps);
  let calls = done.calls;
  let texts = done.texts;
  const byId = done.stepIds.size > 0;
  let firstIndex = -1;
  const remaining = steps.filter((s, i) => {
    let left: boolean;
    if (byId) left = !done.stepIds.has(s.id);
    else if (s.channel === 'voice') {
      left = calls === 0;
      if (!left) calls -= 1;
    } else {
      left = texts === 0;
      if (!left) texts -= 1;
    }
    if (left && firstIndex < 0) firstIndex = i;
    return left;
  });
  return { remaining, dueAt: enrolledAt + (firstIndex < 0 ? 0 : offsets[firstIndex]) };
}

/** What the calls this strategy placed say about the next step. */
export interface CallState {
  /** Queued, ringing or live. */
  open: boolean;
  /** The latest call was a conversation. */
  talked: boolean;
  /** That conversation has been scored. */
  scored: boolean;
  /** How the latest call that has ended went; null before any has. */
  lastCall: CallDisposition | null;
  /** When the latest call ended; null while none has. */
  endedAt: number | null;
}

interface Guardrails {
  respectQuietHours?: boolean;
  quietHours?: QuietHours;
  maxVoiceAttempts?: number;
  skipDays?: unknown;
}

interface Enrollment {
  orgId: string;
  leadId: string;
  /** When the lead was claimed (first_contact_at): calls placed since then are this strategy's. */
  startedAt: number;
  voiceAttempts: number;
  timers: NodeJS.Timeout[];
  stopped: boolean;
  total: number;
  /** Steps not run yet, in order; each one is scheduled only once the one before it has run. */
  queue: StrategyStep[];
  /** Holds already logged, by step and reason, so a step re-checked every 30 s logs its hold once. */
  held: Set<string>;
  /** The step run last was skipped, so a condition on the next one has nothing to check. */
  previousSkipped: boolean;
  /** Steps whose text or call has gone out (or was being sent): a retry after an error never sends one twice. */
  sent: Set<string>;
  /** Errors in a row; reset once a run gets through. */
  failures: number;
}

/**
 * Runs the outreach strategy for each new lead: the configured SMS and AI call
 * steps one after another, each waiting its own time after the step before,
 * held back during quiet hours, while a call is open and while the lead is
 * texting with the AI, and stopped the moment the lead books, opts out or
 * reaches any outcome. Enrolment is claimed in the database (first_contact_at),
 * so only one instance ever runs a lead; in-flight leads are resumed after a
 * restart by LeadWatcherService.
 */
@Injectable()
export class EngineService implements OnModuleDestroy {
  private readonly logger = new Logger('Engine');
  private readonly active = new Map<string, Enrollment>();
  /** Claimed or being resumed, strategy not loaded yet: counted as running, so nothing starts it twice. */
  private readonly starting = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategies: StrategyStoreService,
    private readonly providers: CallingProviders,
    private readonly calls: CallQueue,
    private readonly activity: ActivityService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly state: LeadStateService,
    private readonly conversations: SmsConversationService,
  ) {}

  onModuleDestroy(): void {
    for (const enrollment of this.active.values()) this.halt(enrollment);
    this.active.clear();
  }

  async enroll(orgId: string, leadId: string): Promise<void> {
    if (this.isRunning(leadId)) return;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId } });
    if (!lead || lead.dncStatus || lead.automationPaused) return;
    const claimedAt = new Date();
    this.starting.add(leadId);
    try {
      // The claim and the status move commit together, so a failed status update never leaves a claimed lead stuck in `new`.
      const claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.lead.updateMany({ where: { id: leadId, firstContactAt: null }, data: { firstContactAt: claimedAt } });
        if (claim.count === 0) return false;
        await this.state.move(leadId, LeadStatus.contacting, { source: 'strategy', reason: 'Outreach strategy started' }, tx);
        return true;
      });
      if (!claimed) return;

      // Should this fail, the lead stays claimed and not running: the watcher resumes it.
      const [strategy, office] = await Promise.all([this.strategies.getStrategy(orgId), this.office(orgId)]);
      const enrollment: Enrollment = {
        orgId,
        leadId,
        startedAt: claimedAt.getTime(),
        voiceAttempts: 0,
        timers: [],
        stopped: false,
        total: strategy.steps.length,
        queue: [...strategy.steps],
        held: new Set(),
        previousSkipped: false,
        sent: new Set(),
        failures: 0,
      };
      this.active.set(leadId, enrollment);
      this.logger.log(`enrolled lead ${leadId} into "${strategy.name}" — ${strategy.steps.length} steps`);
      const first = enrollment.queue[0];
      this.next(enrollment, first ? claimedAt.getTime() + offsetMs(first.after) : Date.now(), office, strategy.guardrails as Guardrails);
    } finally {
      this.starting.delete(leadId);
    }
  }

  /**
   * Picks up a lead whose strategy is not running here (after a restart, or a
   * claim whose start failed), skipping the steps already taken.
   */
  async resume(orgId: string, leadId: string): Promise<boolean> {
    if (this.isRunning(leadId)) return false;
    this.starting.add(leadId);
    try {
      return await this.resumeClaimed(orgId, leadId);
    } finally {
      this.starting.delete(leadId);
    }
  }

  private async resumeClaimed(orgId: string, leadId: string): Promise<boolean> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId },
      select: { firstContactAt: true, status: true, dncStatus: true, automationPaused: true, callbackAt: true },
    });
    if (!lead?.firstContactAt || lead.dncStatus || lead.automationPaused || !IN_STRATEGY_STATUSES.includes(lead.status)) return false;
    if (callbackPending(lead)) return false;

    const since = lead.firstContactAt;
    // A lead that left the strategy (stopped, or moved to follow-up or an outcome) and is back in an
    // in-strategy status, as a reply from follow-up makes it engaged, is not in the strategy again.
    const left = await this.prisma.leadEvent.findFirst({
      where: { leadId, createdAt: { gte: since }, OR: [{ type: 'strategy_stopped' }, { type: 'status_changed', toStatus: { notIn: IN_STRATEGY_STATUSES } }] },
      select: { id: true },
    });
    if (left) return false;
    const [calls, texts, logged, strategy, office] = await Promise.all([
      this.prisma.call.count({ where: { orgId, leadId, createdAt: { gte: since } } }),
      // The fallback for leads from before the step log; it cannot tell the AI's chat replies from our steps.
      this.prisma.message.count({ where: { orgId, leadId, direction: 'outbound', channel: 'sms', createdAt: { gte: since } } }),
      this.prisma.leadEvent.findMany({
        where: { leadId, source: 'strategy', type: { in: ['step_sent', 'step_skipped', 'step_failed'] }, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { type: true, payload: true },
      }),
      this.strategies.getStrategy(orgId),
      this.office(orgId),
    ]);
    const stepIds = new Set(logged.map((e) => (e.payload as { stepId?: string } | null)?.stepId).filter((id): id is string => !!id));
    const { remaining, dueAt } = remainingSteps(strategy.steps, { stepIds, calls, texts }, since.getTime());
    const enrollment: Enrollment = {
      orgId,
      leadId,
      startedAt: since.getTime(),
      voiceAttempts: calls,
      timers: [],
      stopped: false,
      total: strategy.steps.length,
      queue: remaining,
      held: new Set(),
      previousSkipped: logged.at(-1)?.type === 'step_skipped',
      sent: new Set(),
      failures: 0,
    };
    this.active.set(leadId, enrollment);
    this.logger.log(`resumed lead ${leadId} — ${remaining.length} of ${enrollment.total} step(s) left`);
    this.next(enrollment, dueAt, office, strategy.guardrails as Guardrails);
    return true;
  }

  /** A lead whose strategy was interrupted for longer than it could resume is parked for follow-up. */
  async finalizeAbandoned(orgId: string, leadId: string): Promise<boolean> {
    if (this.isRunning(leadId)) return false;
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
    opts: { callbackRequested?: boolean; actor?: Actor } = {},
  ): Promise<void> {
    const isHot = temperature === 'hot';
    const current = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { status: true, followUpReason: true } });
    if (!current) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    let reason: FollowUpReason = FollowUpReason.not_ready;
    if (!isHot) {
      const askedBefore = current.status === LeadStatus.follow_up && current.followUpReason === FollowUpReason.callback_requested;
      if (opts.callbackRequested || askedBefore) reason = FollowUpReason.callback_requested;
    }
    const manual = opts.actor?.type === 'user';
    const { moved } = await this.state.move(leadId, isHot ? LeadStatus.interested : LeadStatus.follow_up, {
      source: manual ? 'agent' : 'scoring',
      manual,
      actor: opts.actor,
      reason: summary ?? `Qualified as ${temperature}`,
      data: { temperature, ...(summary ? { aiSummary: summary } : {}), ...(isHot ? {} : { followUpReason: reason }) },
    });
    if (!moved) {
      // A booked or closed lead keeps its status; the new score still counts.
      await this.prisma.lead.updateMany({ where: { id: leadId, orgId }, data: { temperature } });
      return;
    }
    this.stopFor(leadId);

    try {
      const code =
        (!isHot ? await this.followup.sequenceForTrigger(orgId, `follow_up_${reason}` as SequenceTrigger) : undefined) ??
        (await this.followup.sequenceForTrigger(orgId, `qualified_${temperature}` as SequenceTrigger));
      if (code) await this.followup.enroll(orgId, leadId, code);
    } catch (error) {
      this.logger.error(`auto-enrol ${leadId} (${temperature}): ${(error as Error).message}`);
    }
  }

  /** A booking wins over every status but a wrong number: the lead made it themselves, so it ends all outreach. */
  async appointmentBooked(orgId: string, leadId: string, source = 'calendar'): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { id: true } });
    if (!lead) return;
    const { moved } = await this.state.move(leadId, LeadStatus.appointment_booked, { source, reason: 'Appointment booked' });
    if (!moved) return;
    if (this.active.has(leadId)) {
      this.stopFor(leadId);
      this.state.quietly({ orgId, leadId, type: 'strategy_stopped', source, reason: 'Appointment booked' });
    }
    await this.followup.stopForLead(orgId, leadId, 'appointment_booked');
  }

  /**
   * Sets a status. A person (actor type user) may set any; anything else is
   * held to the automation rules and returns false when refused.
   */
  async setStatus(
    orgId: string,
    leadId: string,
    status: LeadStatus,
    reason?: string,
    opts: { followUpReason?: FollowUpReason; optOut?: boolean; actor?: Actor; source?: string } = {},
  ): Promise<boolean> {
    const optOut = Boolean(opts.optOut) && status === LeadStatus.not_interested;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { id: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    const manual = opts.actor?.type === 'user';
    // An opt-out sets DNC and stops the sequences together: never one without the other.
    const moved = await this.prisma.$transaction(async (tx) => {
      const result = await this.state.move(
        leadId,
        status,
        {
          source: opts.source ?? (manual ? 'agent' : 'system'),
          manual,
          actor: opts.actor,
          reason,
          data: {
            ...(reason ? { aiSummary: reason.slice(0, 2000) } : {}),
            ...(status === LeadStatus.follow_up ? { followUpReason: opts.followUpReason ?? FollowUpReason.other } : {}),
            ...(optOut ? { dncStatus: true, automationPaused: true, consentStatus: ConsentStatus.revoked } : {}),
            ...(INACTIVE_STATUSES.includes(status) && reason ? { lostReason: reason.slice(0, 255) } : {}),
          },
        },
        tx,
      );
      if (!result.moved) return false;
      if (optOut) await this.followup.stopForLead(orgId, leadId, 'opted_out', tx);
      else if (INACTIVE_STATUSES.includes(status)) await this.followup.stopForLead(orgId, leadId, `lead_${status}`, tx);
      return true;
    });
    if (!moved) return false;
    if (!IN_STRATEGY_STATUSES.includes(status)) this.stopFor(leadId);
    if (status === LeadStatus.follow_up) await this.enrolOnFollowUp(orgId, leadId);
    return true;
  }

  isRunning(leadId: string): boolean {
    return this.active.has(leadId) || this.starting.has(leadId);
  }

  /** Something else now decides the lead's next contact (a callback, an outcome they stated): the strategy stops here. */
  stopStrategy(orgId: string, leadId: string, source: string, reason: string): void {
    if (!this.active.has(leadId)) return;
    this.stopFor(leadId);
    this.state.quietly({ orgId, leadId, type: 'strategy_stopped', source, reason });
  }

  /** Schedules the next queued step for `dueAt`, or the close of the strategy when none is left. */
  private next(e: Enrollment, dueAt: number, office: Office, guardrails: Guardrails): void {
    const step = e.queue.shift();
    if (!step) return this.scheduleFinalize(e);
    this.later(e, () => this.fireStep(e, step, office, guardrails), dueAt - Date.now());
  }

  private async fireStep(e: Enrollment, step: StrategyStep, office: Office, guardrails: Guardrails, heldSince?: number): Promise<void> {
    if (e.stopped) return;
    // Tried again after an error once its text or call had gone out: move on, never send it twice.
    if (e.sent.has(step.id)) return this.next(e, Date.now() + (e.queue[0] ? offsetMs(e.queue[0].after) : 0), office, guardrails);
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
    if (!lead || lead.dncStatus || lead.automationPaused || OUTCOME_STATUSES.includes(lead.status)) return this.stop(e);
    if (callbackPending(lead)) {
      this.state.quietly({ orgId: e.orgId, leadId: e.leadId, type: 'strategy_stopped', source: 'strategy', reason: 'A callback the lead asked for is due' });
      return this.stop(e);
    }
    // A meeting on the calendar ends the strategy whatever the status says, and the status follows it.
    if (await hasUpcomingMeeting(this.prisma, e.orgId, e.leadId)) {
      this.state.quietly({ orgId: e.orgId, leadId: e.leadId, type: 'strategy_stopped', source: 'calendar', reason: 'A meeting with the lead is on the calendar' });
      this.stop(e);
      return this.appointmentBooked(e.orgId, e.leadId, 'calendar');
    }

    const quiet = guardrails?.respectQuietHours === false ? undefined : guardrails?.quietHours;
    const now = Date.now();
    const allowedAt = nextContactAt(office.timeZone, quiet, skipDaysOf(guardrails?.skipDays), new Date(now)).getTime();
    if (allowedAt > now) {
      this.later(e, () => this.fireStep(e, step, office, guardrails, heldSince), allowedAt - now);
      return;
    }

    const event = { orgId: e.orgId, leadId: e.leadId, source: 'strategy', channel: step.channel, payload: { stepId: step.id } };
    const hold = (reason: string) => {
      const key = `${step.id}:${reason}`;
      if (e.held.has(key)) return;
      e.held.add(key);
      this.state.quietly({ ...event, type: 'step_held', reason });
    };

    // While the lead is texting with the AI, a canned text would talk over the
    // chat, and a call waits until the chat has gone quiet for the step's wait.
    const chat = await this.chatState(e);
    if (chat.replied && step.channel === 'sms') {
      this.state.quietly({ ...event, type: 'step_skipped', reason: 'The lead is texting with the AI' });
      e.previousSkipped = true;
      return this.next(e, Date.now() + (e.queue[0] ? offsetMs(e.queue[0].after) : 0), office, guardrails);
    }
    if (chat.replied) {
      const quietFor = Date.now() - chat.lastAt;
      const needed = Math.max(offsetMs(step.after), MIN_CHAT_QUIET_MS);
      if (quietFor < needed) {
        hold('Waiting for the text chat to go quiet');
        this.later(e, () => this.fireStep(e, step, office, guardrails), needed - quietFor);
        return;
      }
    }

    // Nothing is sent over a call that is still queued, ringing or live, and
    // nothing follows a conversation: the call's scoring decides what comes next.
    const call = await this.callState(e);
    if (call.open) {
      const since = heldSince ?? Date.now();
      hold('A call is still queued, ringing or live');
      if (Date.now() - since < CALL_HOLD_MAX_MS) {
        this.later(e, () => this.fireStep(e, step, office, guardrails, since), CALL_HOLD_RECHECK_MS);
        return;
      }
      this.logger.warn(`lead ${e.leadId}: step ${step.id} goes ahead after ${CALL_HOLD_MAX_MS / 60_000} min waiting for an open call`);
    }
    // A pick-up is a conversation once the call analysis says a person was there (a voicemail the
    // detection missed is not one). It comes a minute or two after the hang-up.
    if (call.talked && !call.scored && call.endedAt && Date.now() - call.endedAt < SCORING_WAIT_MS) {
      hold('Waiting for the call analysis');
      this.later(e, () => this.fireStep(e, step, office, guardrails), CALL_HOLD_RECHECK_MS);
      return;
    }

    const unmet = call.talked ? null : unmetCondition(step.onlyIf, { lastCall: call.lastCall, replied: chat.replied, previousSkipped: e.previousSkipped });
    const capped = !call.talked && !unmet && step.channel === 'voice' && (guardrails?.maxVoiceAttempts ?? 99) <= e.voiceAttempts;
    const sending = !call.talked && !unmet && !capped;
    let phone = lead.phone;
    if (sending) {
      // The day's limit or the gap since our last touch on this channel: the step waits, it is not dropped.
      const slot = await this.followup.contactSlot(e.orgId, e.leadId, step.channel);
      if (slot.at.getTime() > Date.now()) {
        hold(slot.reason ?? 'Waiting for the contact limits');
        this.later(e, () => this.fireStep(e, step, office, guardrails), slot.at.getTime() - Date.now());
        return;
      }
      // Looked at once more right before anything goes out: a reply, an opt-out, a booking or a
      // pause may have come in while the step was being decided.
      const fresh = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
      if (e.stopped) return;
      if (!fresh || fresh.dncStatus || fresh.automationPaused || OUTCOME_STATUSES.includes(fresh.status) || callbackPending(fresh)) return this.stop(e);
      if (step.channel === 'sms' && (await this.chatState(e)).replied) return this.fireStep(e, step, office, guardrails, heldSince);
      phone = fresh.phone;
      e.sent.add(step.id);
    }

    if (call.talked) {
      this.logger.log(`lead ${e.leadId}: step ${step.id} skipped — the lead already talked on the last call`);
      this.state.quietly({ ...event, type: 'step_skipped', reason: 'The lead already talked on the last call' });
    } else if (unmet) {
      this.state.quietly({ ...event, type: 'step_skipped', reason: unmet });
    } else if (step.channel === 'sms') {
      const variables = await this.activity.leadVariables(e.orgId, e.leadId);
      const text = fillTemplate(step.message ?? '', { ...variables, brokerage: office.brokerage });
      try {
        const provider = await this.providers.for(e.orgId);
        if (!provider.capabilities.sms) {
          // Retell sends no SMS: the step is logged as skipped, never as failed, and the strategy goes on.
          this.logger.log(`lead ${e.leadId}: SMS step ${step.id} skipped — ${provider.name} sends no SMS`);
          this.state.quietly({ ...event, type: 'step_skipped', reason: SMS_UNAVAILABLE });
        } else {
          const sent = await provider.sendSms(e.orgId, phone ?? '', text);
          await this.activity.recordSms(e.orgId, e.leadId, text, true, sent.id);
          this.state.quietly({ ...event, type: 'step_sent' });
          this.conversations
            .appendOurMessage(e.orgId, phone, text)
            .catch((error) => this.logger.warn(`lead ${e.leadId}: adding our text to the AI chat failed: ${(error as Error).message}`));
        }
      } catch (error) {
        await this.activity.recordSms(e.orgId, e.leadId, text, false, (error as Error).message);
        this.state.quietly({ ...event, type: 'step_failed', reason: (error as Error).message });
      }
    } else if (step.channel === 'voice' && !capped) {
      e.voiceAttempts += 1;
      try {
        await this.calls.enqueue(
          {
            orgId: e.orgId,
            leadId: e.leadId,
            source: 'strategy',
            ...(step.voicemail && step.voicemail !== 'default' ? { voicemail: step.voicemail } : {}),
            ...(step.context ? { context: step.context } : {}),
          },
          { dedupeKey: `strategy:${e.leadId}:${e.startedAt}:${e.voiceAttempts}` },
        );
        this.state.quietly({ ...event, type: 'step_sent', reason: `Call ${e.voiceAttempts} queued` });
      } catch (error) {
        await this.activity.recordCallFailed(e.orgId, e.leadId, (error as Error).message, undefined, await this.providers.nameFor(e.orgId).catch(() => undefined));
        this.state.quietly({ ...event, type: 'step_failed', reason: (error as Error).message });
      }
    } else if (step.channel === 'voice') {
      this.state.quietly({ ...event, type: 'step_skipped', reason: `Call limit of ${guardrails?.maxVoiceAttempts} reached` });
    }
    e.previousSkipped = call.talked || !!unmet || capped;
    const following = e.queue[0];
    this.next(e, Date.now() + (following ? offsetMs(following.after) : 0), office, guardrails);
  }

  /** The calls placed since the strategy started: one queued but not on record yet counts as open. */
  /** Whether the lead has texted back since the strategy started, and when the chat last moved, on either side. */
  private async chatState(e: Enrollment): Promise<{ replied: boolean; lastAt: number }> {
    const since = new Date(e.startedAt);
    const [reply, last] = await Promise.all([
      this.prisma.message.findFirst({ where: { leadId: e.leadId, channel: 'sms', direction: 'inbound', createdAt: { gte: since } }, select: { id: true } }),
      this.prisma.message.findFirst({
        where: { leadId: e.leadId, channel: 'sms', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    return { replied: reply !== null, lastAt: last?.createdAt.getTime() ?? 0 };
  }

  private async callState(e: Enrollment): Promise<CallState> {
    const since = new Date(e.startedAt);
    const [placed, latest] = await Promise.all([
      this.prisma.call.count({ where: { leadId: e.leadId, createdAt: { gte: since } } }),
      this.prisma.call.findFirst({
        where: { leadId: e.leadId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { status: true, durationSeconds: true, disposition: true, endedAt: true, extractedIntel: true },
      }),
    ]);
    const open = e.voiceAttempts > placed || (latest !== null && OPEN_CALL.includes(latest.status));
    // A voicemail is answered too, so the disposition decides; a call from before dispositions falls back to its length.
    const talked = latest?.disposition
      ? latest.disposition === CallDisposition.connected
      : latest?.status === CallStatus.completed && (latest.durationSeconds ?? 0) >= CONVERSATION_MIN_SECS;
    const scored = Boolean((latest?.extractedIntel as { qualification?: unknown } | null)?.qualification);
    const lastCall = latest?.endedAt ? (latest.disposition ?? null) : null;
    return { open, talked, scored, lastCall, endedAt: latest?.endedAt?.getTime() ?? null };
  }

  private scheduleFinalize(e: Enrollment): void {
    this.later(e, () => this.finalize(e), FINALIZE_AFTER_MS);
  }

  /**
   * Closes the strategy once its last call is over and, if the lead talked,
   * scored: the score decides the follow-up, so closing first would park the
   * lead on a guess.
   */
  private async finalize(e: Enrollment, waitingSince = Date.now()): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
    if (lead && !OUTCOME_STATUSES.includes(lead.status) && !lead.dncStatus) {
      const call = await this.callState(e);
      const waited = Date.now() - waitingSince;
      if ((call.open && waited < CALL_HOLD_MAX_MS) || (!call.open && call.talked && !call.scored && waited < SCORING_WAIT_MS)) {
        this.later(e, () => this.finalize(e, waitingSince), CALL_HOLD_RECHECK_MS);
        return;
      }
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
   * Runs `run` after `delayMs`, in pieces when that is longer than one timer
   * holds. A run that throws is tried again with backoff; a fired timer is let go.
   */
  private later(e: Enrollment, run: () => Promise<void>, delayMs: number): void {
    const delay = Math.max(0, delayMs);
    const timer = setTimeout(() => {
      e.timers = e.timers.filter((t) => t !== timer);
      if (delay > MAX_TIMER_MS) return this.later(e, run, delay - MAX_TIMER_MS);
      run().then(
        () => {
          e.failures = 0;
        },
        (error: Error) => this.retry(e, run, error),
      );
    }, Math.min(delay, MAX_TIMER_MS));
    timer.unref();
    e.timers.push(timer);
  }

  /** A database or Redis blip should not leave the lead hanging: try again, waiting longer each time, then park it. */
  private retry(e: Enrollment, run: () => Promise<void>, error: Error): void {
    if (e.stopped) return;
    e.failures += 1;
    if (e.failures > MAX_STEP_FAILURES) return void this.giveUp(e, error);
    const wait = Math.min(STEP_RETRY_BASE_MS * 2 ** (e.failures - 1), STEP_RETRY_MAX_MS);
    this.logger.warn(`lead ${e.leadId}: ${error.message} — try ${e.failures + 1} of ${MAX_STEP_FAILURES + 1} in ${Math.round(wait / 1000)}s`);
    this.later(e, run, wait);
  }

  /**
   * Parks a lead whose step kept failing: flagged for review, out to follow-up
   * and its sequence. It counts as running until then, so the watcher cannot
   * resume it halfway; if even parking fails, the watcher picks it up later.
   */
  private async giveUp(e: Enrollment, error: Error): Promise<void> {
    this.logger.error(`lead ${e.leadId}: giving up after ${MAX_STEP_FAILURES + 1} failed tries: ${error.message}`);
    try {
      const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId }, select: { reviewReasons: true } });
      if (lead && !lead.reviewReasons.includes(STEP_FAILED_REVIEW)) {
        await this.prisma.lead.update({ where: { id: e.leadId }, data: { needsReview: true, reviewReasons: { push: STEP_FAILED_REVIEW } } });
      }
      await this.state.record({ orgId: e.orgId, leadId: e.leadId, type: 'strategy_stopped', source: 'strategy', reason: `A step kept failing: ${error.message}`.slice(0, 500) });
      await this.activity.exitStrategy(e.leadId, `Strategy step kept failing — ${error.message}`.slice(0, 2000));
      await this.enrolOnFollowUp(e.orgId, e.leadId);
    } catch (err) {
      this.logger.error(`lead ${e.leadId}: could not park it either: ${(err as Error).message}`);
    } finally {
      this.stop(e);
    }
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

  private async office(orgId: string): Promise<Office> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, settings: { select: { timezone: true } } } });
    return { brokerage: org?.name ?? 'our team', timeZone: org?.settings?.timezone ?? 'UTC' };
  }
}

interface Office {
  brokerage: string;
  timeZone: string;
}

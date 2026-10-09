import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import {
  FollowUpReason,
  IN_STRATEGY_STATUSES,
  INACTIVE_STATUSES,
  LeadStatus,
  OUTCOME_STATUSES,
  normalizeLeadStatus,
} from '../common/domain';
import { AppError } from '../common/errors';
import { deferredResume, inQuietHours, type QuietHours } from '../common/quiet-hours';
import { FollowupService } from '../modules/followup/followup.service';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { SmsService } from './sms.service';
import { StrategyStoreService, type StrategyStep } from './strategy-store.service';
import { VoiceService } from './voice.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Strategy execution engine. On a new lead it enrolls and fires the org's
 * cadence (SMS + AI call) with delays, compliance guardrails, and status updates
 * on the real `leads` table.
 *
 * The scheduler is in-process (setTimeout), so a restart drops every pending
 * step. The schedule is rebuilt on boot from what is durable: the lead's
 * `first_contact_at` (when the cadence started) and the calls and texts on
 * record (which steps already ran) — see resume() and remainingSteps().
 */
const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60000,
  hours: 3600000,
  days: 86400000,
};

const offsetMs = (a: StrategyStep['after']): number => (a?.value ?? 0) * (UNIT_MS[a?.unit] ?? 1000);

/**
 * After a restart: which steps are still to run, and the cadence anchor to run
 * them from.
 *
 * A step counts as run when there is an activity of its channel on record for
 * it, consumed in order — the same walk the lead's Flow view does, so what the
 * owner sees and what the engine resumes cannot disagree. A quiet-hours
 * deferral writes nothing, so a deferred step is correctly still pending.
 *
 * Overdue steps are not fired as one burst: the anchor moves forward so the
 * first remaining step is due now and the rest keep their original gaps.
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

interface Enrollment {
  orgId: string;
  leadId: string;
  voiceAttempts: number;
  timers: NodeJS.Timeout[];
  stopped: boolean;
  /** Steps actually executed. A quiet-hours deferral does not count. */
  ran: number;
  /** Steps in the strategy, so the engine knows when it has finished. */
  total: number;
  /** When enrol() ran. Every step's nominal time is measured from here. */
  enrolledAt: number;
  /**
   * How far the whole cadence has been pushed by quiet hours, in ms.
   *
   * One number for the enrolment rather than one per step: the point is that
   * every deferred step moves by the SAME amount, which is what preserves the
   * gaps between them. See the deferral in fireStep.
   */
  quietShift: number;
}

@Injectable()
export class EngineService implements OnModuleDestroy {
  private readonly logger = new Logger('Engine');
  /** leadId -> enrollment */
  private readonly active = new Map<string, Enrollment>();

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly strategies: StrategyStoreService,
    private readonly sms: SmsService,
    private readonly voice: VoiceService,
    private readonly activity: ActivityService,
    @Inject(forwardRef(() => FollowupService))
    private readonly followup: FollowupService,
  ) {}

  /** Clear every pending timer so a shutdown does not fire steps mid-teardown. */
  onModuleDestroy(): void {
    for (const enrollment of this.active.values()) {
      enrollment.stopped = true;
      enrollment.timers.forEach(clearTimeout);
    }
    this.active.clear();
  }

  /**
   * Enroll a lead and schedule every step. Marks first_contact_at so it is not
   * re-enrolled.
   */
  async enroll(orgId: string, leadId: string): Promise<void> {
    if (this.active.has(leadId)) return;
    // Scoped by organization: `id` alone satisfies the tenancy guard, so an
    // unscoped lookup would enroll another tenant's lead on this org's account.
    const lead = await this.prisma.leads.findFirst({ where: { id: leadId, organization_id: orgId } });
    if (!lead || lead.dnc_status || lead.automation_paused) return;

    // Claim atomically: only the caller that flips first_contact_at from null
    // wins. This closes the race where ingestion and the poll watcher both
    // enroll the same fresh lead (both would otherwise pass the in-memory check).
    const claim = await this.prisma.leads.updateMany({
      where: { id: leadId, first_contact_at: null },
      data: { first_contact_at: new Date() },
    });
    if (claim.count === 0) return;
    // Enrolled: outreach is under way, nobody reached yet.
    await this.prisma.leads.updateMany({
      where: { id: leadId, status: LeadStatus.NEW },
      data: { status: LeadStatus.CONTACTING },
    });

    const strategy = await this.strategies.getStrategy(orgId);
    const org = await this.prisma.organizations.findUnique({
      where: { id: orgId },
      select: { name: true, timezone: true },
    });
    const brokerage = org?.name ?? 'our team';
    const tz = org?.timezone ?? 'America/Chicago';

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
    };
    this.active.set(leadId, enrollment);
    this.logger.log(
      `enrolled lead ${leadId} (${lead.first_name ?? ''}) into "${strategy.name}" — ${strategy.steps.length} steps`,
    );

    this.schedule(enrollment, strategy.steps, brokerage, tz, strategy.guardrails);
  }

  /** One timer per step, each measured from the enrolment's anchor. */
  private schedule(e: Enrollment, steps: StrategyStep[], brokerage: string, tz: string, guardrails: any): void {
    for (const step of steps) {
      const t = setTimeout(
        () => {
          void this.fireStep(e, step, brokerage, tz, guardrails);
        },
        Math.max(0, e.enrolledAt + offsetMs(step.after) - Date.now()),
      );
      if (t.unref) t.unref();
      e.timers.push(t);
    }
  }

  /**
   * Pick a lead's strategy back up after a restart dropped its timers.
   *
   * Only for a lead still IN the strategy (claimed, status new|contacting, not
   * paused or DNC) and not already running here. Steps already on record are
   * not repeated — re-running them would call or text the lead twice.
   *
   * ponytail: assumes one engine process. Two replicas booting together would
   * both resume the same lead; add a lease column on leads if this ever runs
   * more than one instance.
   */
  async resume(orgId: string, leadId: string): Promise<boolean> {
    if (this.active.has(leadId)) return false;
    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, organization_id: orgId },
      select: { first_contact_at: true, status: true, dnc_status: true, automation_paused: true },
    });
    if (!lead?.first_contact_at || lead.dnc_status || lead.automation_paused) return false;
    if (!IN_STRATEGY_STATUSES.includes(lead.status)) return false;

    const [calls, texts, strategy, org] = await Promise.all([
      this.prisma.voice_calls.count({ where: { organization_id: orgId, lead_id: leadId } }),
      this.prisma.messages.count({
        where: { organization_id: orgId, direction: 'outbound', channel: 'sms', conversations: { lead_id: leadId } },
      }),
      this.strategies.getStrategy(orgId),
      this.prisma.organizations.findUnique({ where: { id: orgId }, select: { name: true, timezone: true } }),
    ]);

    const { remaining, anchor } = remainingSteps(
      strategy.steps,
      calls,
      texts,
      lead.first_contact_at.getTime(),
      Date.now(),
    );
    const e: Enrollment = {
      orgId,
      leadId,
      voiceAttempts: calls,
      timers: [],
      stopped: false,
      ran: strategy.steps.length - remaining.length,
      total: strategy.steps.length,
      enrolledAt: anchor,
      quietShift: 0,
    };
    this.active.set(leadId, e);
    this.logger.log(`resumed lead ${leadId} — ${remaining.length} of ${e.total} step(s) left`);

    if (remaining.length === 0) this.scheduleFinalize(e);
    else this.schedule(e, remaining, org?.name ?? 'our team', org?.timezone ?? 'America/Chicago', strategy.guardrails);
    return true;
  }

  private async fireStep(
    e: Enrollment,
    step: StrategyStep,
    brokerage: string,
    tz: string,
    guardrails: any,
  ): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.leads.findUnique({ where: { id: e.leadId } });
    if (!lead) return this.stop(e);
    if (lead.dnc_status || lead.automation_paused) {
      this.logger.log(`stop lead ${e.leadId} (dnc/paused)`);
      return this.stop(e);
    }
    if (OUTCOME_STATUSES.includes(lead.status)) {
      this.logger.log(`stop lead ${e.leadId} (${lead.status})`);
      return this.stop(e);
    }

    /**
     * Quiet hours: wait for the window to open, then keep the cadence.
     *
     * Every step is its own timer measured from enrolment, so for a lead that
     * arrives at 2am they ALL come due inside the quiet window. Re-polling each
     * one every fifteen minutes meant they all found the window open within the
     * same quarter hour and fired together: the opening text, the follow-up text
     * and the AI call arrived back to back at 08:00, and a cadence of 0 / 30min
     * / 2h collapsed into one burst.
     *
     * So the resume is staggered. `nextAllowedAt` gives the moment the window
     * opens — the same function the nurture runner uses, so both schedulers
     * agree on when it is legal to send — and each step then keeps its own
     * offset from that moment, preserving the spacing the strategy was written
     * with. A step already past its offset when the window opens goes first, at
     * the top of the window, which is what "late, not cancelled" means.
     */
    if (guardrails?.respectQuietHours !== false && inQuietHours(tz, guardrails?.quietHours)) {
      const quiet = guardrails?.quietHours as QuietHours | undefined;
      const now = new Date();

      const { shift, resumeAt } = deferredResume({
        tz,
        quiet,
        now: now.getTime(),
        enrolledAt: e.enrolledAt,
        offset: offsetMs(step.after),
        shift: e.quietShift,
      });
      // Kept on the enrolment, not the step: every later step reads it, which
      // is what moves the whole cadence by one amount instead of bunching it.
      e.quietShift = shift;
      const t = setTimeout(
        () => {
          void this.fireStep(e, step, brokerage, tz, guardrails);
        },
        Math.max(0, resumeAt - now.getTime()),
      );
      if (t.unref) t.unref();
      e.timers.push(t);
      this.logger.log(
        `deferred ${step.channel} for lead ${e.leadId} to ${new Date(resumeAt).toISOString()} (quiet hours)`,
      );
      return;
    }

    const firstName = (lead.first_name ?? '').trim() || 'there';
    if (step.channel === 'sms') {
      const text = (step.message ?? '')
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/\{\{brokerage\}\}/g, brokerage);
      try {
        const r: any = await this.sms.sendSms(e.orgId, lead.phone ?? '', text);
        // -> message 'sent', lead 'contacting'
        await this.activity.recordSms(e.orgId, e.leadId, text, true, r?.id);
        this.logger.log(`SMS sent to lead ${e.leadId}`);
      } catch (err) {
        // -> message 'failed', and the reason noted on the lead
        await this.activity.recordSms(e.orgId, e.leadId, text, false, (err as Error).message);
        this.logger.warn(`SMS FAILED for lead ${e.leadId}: ${(err as Error).message}`);
      }
    } else if (step.channel === 'voice') {
      if ((guardrails?.maxVoiceAttempts ?? 99) <= e.voiceAttempts) {
        this.logger.log(`skip call (max attempts) lead ${e.leadId}`);
      } else {
        e.voiceAttempts += 1;
        try {
          const r: any = await this.voice.placeCall(e.orgId, lead.phone ?? '', {
            leadId: e.leadId,
            orgId: e.orgId,
          });
          // -> voice_call 'ringing'; the webhook sets the outcome
          await this.activity.startCall(e.orgId, e.leadId, r?.call_control_id);
          this.logger.log(`AI call dialed to lead ${e.leadId}`);
        } catch (err) {
          // -> voice_call 'failed'. Does NOT exit the strategy.
          await this.activity.recordCallFailed(e.orgId, e.leadId, (err as Error).message);
          this.logger.warn(`call FAILED for lead ${e.leadId}: ${(err as Error).message}`);
        }
      }
    }

    // This step is done, whether it fired or was skipped — a quiet-hours deferral
    // returned earlier and never reaches here. One step failing never ends the
    // strategy: the lead runs every step and leaves only once all are exhausted.
    e.ran += 1;
    if (e.ran >= e.total) this.scheduleFinalize(e);
  }

  /**
   * After the last step, wait before deciding. A voice call resolves through the
   * Call Control webhook, which arrives seconds later — finalizing immediately
   * would park a lead who is, at that moment, mid-conversation.
   */
  private scheduleFinalize(e: Enrollment): void {
    const t = setTimeout(() => {
      void this.finalize(e);
    }, 90 * 1000);
    if (t.unref) t.unref();
    e.timers.push(t);
  }

  /**
   * Every step has run. A lead that did not convert exits into follow-up, and
   * this is the ONLY place that happens for not converting — a qualified or
   * booked lead was already stopped by qualified().
   */
  private async finalize(e: Enrollment): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.leads.findUnique({ where: { id: e.leadId } });
    if (!lead) return this.stop(e);

    if (!OUTCOME_STATUSES.includes(lead.status) && !lead.dnc_status) {
      const why = `Strategy complete after ${e.total} step(s) — ${lead.ai_summary || 'lead not converted'}`;
      await this.activity.exitStrategy(e.leadId, why.slice(0, 2000));
      this.logger.log(`lead ${e.leadId} exited strategy (all ${e.total} steps done, not converted)`);
      await this.enrolOnFollowUp(e.orgId, e.leadId);
    }
    this.stop(e);
  }

  /**
   * Close out a lead the engine was working when the process died.
   *
   * The strategy's schedule lives in `setTimeout`, so a restart drops every
   * pending step. The lead is left holding the engine's claim — `first_contact_at`
   * set, status still new|contacting — and nothing ever comes back for it: the
   * watcher only picks up leads with `first_contact_at` NULL, and finalize()
   * only runs for an enrolment this process owns. Before this, a deploy in the
   * middle of a strategy stranded those leads permanently: never finished,
   * never nurtured, and (since the enrolment guard reads the same signature)
   * not even addable to a sequence by hand.
   *
   * Recovery is the strategy's own ending, not a restart of it. The steps that
   * already fired were really sent, and re-running them would text the lead
   * twice; what is missing is the exit, so that is what this performs.
   *
   * The caller is responsible for only offering leads whose claim is old enough
   * that no live strategy could still be running — see LeadWatcher.
   */
  async finalizeAbandoned(orgId: string, leadId: string): Promise<boolean> {
    // Owned by THIS process, so its timers are intact and it is not abandoned.
    if (this.active.has(leadId)) return false;

    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, organization_id: orgId },
      select: { id: true, status: true, dnc_status: true, ai_summary: true },
    });
    if (!lead) return false;

    if (OUTCOME_STATUSES.includes(lead.status) || lead.dnc_status) return false;

    const why = `Strategy interrupted — ${lead.ai_summary || 'recovered after a restart'}`;
    await this.activity.exitStrategy(leadId, why.slice(0, 2000));
    this.logger.log(`recovered stranded lead ${leadId} — exited strategy`);
    await this.enrolOnFollowUp(orgId, leadId);
    return true;
  }

  /**
   * The lead is parked in follow_up: hand it to whatever sequence the office
   * pointed at its follow-up reason ('follow_up_<reason>').
   *
   * Reads the reason from the row rather than taking it as an argument, so the
   * strategy exit (which works it out from the calls and replies on record) and
   * a status set by the AI call or by hand all enrol by the same rule. A lead
   * not in follow_up — it reached an outcome first — is left alone.
   *
   * Deliberately mirrors qualified(): enrolment must never throw, because the
   * status change itself is already recorded and a parked lead without an
   * enrolment can be added by hand, while losing the status cannot be undone.
   */
  private async enrolOnFollowUp(orgId: string, leadId: string): Promise<void> {
    try {
      const lead = await this.prisma.leads.findFirst({
        where: { id: leadId, organization_id: orgId },
        select: { status: true, follow_up_reason: true },
      });
      if (!lead || lead.status !== LeadStatus.FOLLOW_UP || !lead.follow_up_reason) return;
      const trigger = `follow_up_${lead.follow_up_reason}`;
      const code = await this.followup.sequenceForTrigger(orgId, trigger);
      if (!code) {
        this.logger.log(`lead ${leadId} in follow-up (${lead.follow_up_reason}) — no sequence claims it`);
        return;
      }
      await this.followup.enroll(orgId, leadId, code);
      this.logger.log(`lead ${leadId} in follow-up (${lead.follow_up_reason}) — enrolled in ${code}`);
    } catch (err) {
      this.logger.error(`follow-up enrol ${leadId}: ${(err as Error).message}`);
    }
  }

  private stop(e: Enrollment): void {
    e.stopped = true;
    e.timers.forEach(clearTimeout);
    this.active.delete(e.leadId);
  }

  /**
   * Called when the AI call qualifies the lead — ends the strategy and hands
   * the lead to whatever comes next for its temperature.
   *
   * The branch is on `temperature` and never on `score`: score is written as 0
   * and never computed, so branching on it would send every lead down the same
   * path. Temperature arrives verbatim in the body of
   * POST /api/leads/:id/qualified, which the Telnyx assistant calls as a tool.
   *
   * Two decisions, deliberately separate:
   *
   *  - **Status** follows temperature alone. Hot is `interested` and waits
   *    for routing to give it an agent; warm and cold go to `follow_up`
   *    (not_ready). This is not conditional on a sequence existing — tying the
   *    two together made an office with no warm sequence silently mark warm
   *    leads as hot and queue them for an agent.
   *  - **Enrolment** follows whatever sequence claims that temperature, which
   *    is now a per-sequence setting an office edits rather than a constant.
   *    Nothing claiming it means nobody is added automatically, which is a
   *    legitimate configuration, not a failure.
   *
   * Warm and cold deliberately get no agent either way: an agent's queue stops
   * being a to-do list the moment every lead is on it.
   */
  async qualified(
    orgId: string,
    leadId: string,
    temperature: string,
    summary?: string,
    opts: { callbackRequested?: boolean } = {},
  ): Promise<void> {
    const isHot = temperature === 'hot';

    // Warm and cold are not_ready, unless the caller asked to be called back —
    // said in the call (callbackRequested) or already recorded by the in-call
    // outcome tool, which the post-call score must not overwrite.
    let reason: FollowUpReason = FollowUpReason.NOT_READY;
    if (!isHot) {
      const cur = await this.prisma.leads.findFirst({
        where: { id: leadId, organization_id: orgId },
        select: { status: true, follow_up_reason: true },
      });
      const askedBefore =
        cur?.status === LeadStatus.FOLLOW_UP && cur.follow_up_reason === FollowUpReason.CALLBACK_REQUESTED;
      if (opts.callbackRequested || askedBefore) reason = FollowUpReason.CALLBACK_REQUESTED;
    }

    // Scoped by organization in the write itself, so a lead id from another
    // tenant is not found — the same 404 as one that does not exist.
    const updated = await this.prisma.leads.updateMany({
      where: { id: leadId, organization_id: orgId },
      data: {
        ...(isHot
          ? { status: LeadStatus.INTERESTED }
          : { status: LeadStatus.FOLLOW_UP, follow_up_reason: reason }),
        temperature,
        ...(summary ? { ai_summary: summary } : {}),
      },
    });
    if (updated.count === 0) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    const e = this.active.get(leadId);
    if (e) this.stop(e);

    // Enrolment must not fail the webhook: the qualification itself is already
    // recorded, and a parked lead without an enrolment can be added
    // by hand. Losing the temperature because a seed query timed out cannot.
    //
    // A parked lead goes to the sequence claiming its follow-up reason first —
    // "call me back" is more specific than "cold" — and to the temperature's
    // sequence only when no sequence claims the reason.
    try {
      const code =
        (!isHot ? await this.followup.sequenceForTrigger(orgId, `follow_up_${reason}`) : undefined) ??
        (await this.followup.sequenceForTemperature(orgId, temperature));
      if (!code) {
        this.logger.log(
          `lead ${leadId} qualified as ${temperature}${isHot ? '' : ` (${reason})`} — strategy stopped, no sequence claims it`,
        );
        return;
      }
      await this.followup.enroll(orgId, leadId, code);
      this.logger.log(`lead ${leadId} is ${temperature} — strategy stopped, enrolled in ${code}`);
    } catch (err) {
      this.logger.error(`auto-enrol ${leadId} (${temperature}): ${(err as Error).message}`);
    }
  }

  /**
   * Called when an appointment lands for this lead — today from the Calendly
   * sync, later from anything else that books one.
   *
   * The same shape as qualified(): set the status, then clear the pending
   * timers. That second half is the point. Without it the cadence keeps its
   * setTimeouts and goes on texting and calling somebody who has already put a
   * meeting in the calendar, which is exactly the experience that gets a
   * brokerage's number flagged.
   *
   * Writes 'appointment_booked' (lead_status_v2); a legacy 'booked' row is
   * treated as already booked.
   */
  async appointmentBooked(orgId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.leads.findUnique({ where: { id: leadId } });
    if (!lead) return;

    // Never drag a finished lead backwards, and never overwrite a do-not-call
    // flag: a booking is good news, but it is not a reason to reopen a lead
    // somebody deliberately closed.
    if (INACTIVE_STATUSES.includes(lead.status) || lead.dnc_status) {
      this.logger.log(`lead ${leadId} booked but left at '${lead.status}' (terminal)`);
      return;
    }

    if (normalizeLeadStatus(lead.status) !== LeadStatus.APPOINTMENT_BOOKED) {
      await this.prisma.leads.update({ where: { id: leadId }, data: { status: LeadStatus.APPOINTMENT_BOOKED } });
    }

    const e = this.active.get(leadId);
    if (e) {
      this.stop(e);
      await this.activity.exitStrategy(leadId, 'Appointment booked — strategy stopped');
    }
    this.logger.log(`lead ${leadId} booked — strategy stopped`);
  }

  /**
   * Put a lead in a status directly: the AI call reporting an outcome other
   * than a temperature, or a person moving the lead by hand.
   *
   * Any outcome or parked status ends the strategy, exactly as qualified() and
   * appointmentBooked() do — a lead somebody has just marked not interested
   * must not get the next scheduled text. `optOut` (not_interested only) also
   * sets the do-not-contact flag, because that flag, not the status, is what
   * every send path reads. follow_up always carries a reason: `followUpReason`,
   * or 'other' when none is given.
   */
  async setStatus(
    orgId: string,
    leadId: string,
    status: LeadStatus,
    reason?: string,
    opts: { followUpReason?: FollowUpReason; optOut?: boolean } = {},
  ): Promise<void> {
    const optOut = !!opts.optOut && status === LeadStatus.NOT_INTERESTED;
    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, organization_id: orgId },
      select: { id: true },
    });
    if (!lead) throw new Error('Lead not found');

    await this.prisma.leads.update({
      where: { id: leadId },
      data: {
        status,
        ...(reason ? { ai_summary: reason.slice(0, 2000) } : {}),
        ...(status === LeadStatus.FOLLOW_UP
          ? { follow_up_reason: opts.followUpReason ?? FollowUpReason.OTHER }
          : {}),
        ...(optOut ? { dnc_status: true, automation_paused: true, consent_status: 'revoked' } : {}),
        ...([LeadStatus.NOT_INTERESTED, LeadStatus.INVALID, LeadStatus.CLOSED] as string[]).includes(
          status,
        ) && reason
          ? { lost_reason: reason.slice(0, 255) }
          : {},
      },
    });

    if (!IN_STRATEGY_STATUSES.includes(status)) {
      const e = this.active.get(leadId);
      if (e) this.stop(e);
    }
    if (status === LeadStatus.FOLLOW_UP) await this.enrolOnFollowUp(orgId, leadId);
    const detail = status === LeadStatus.FOLLOW_UP ? `/${opts.followUpReason ?? FollowUpReason.OTHER}` : optOut ? '/dnc' : '';
    this.logger.log(`lead ${leadId} -> ${status}${detail}${reason ? ` (${reason})` : ''}`);
  }
}

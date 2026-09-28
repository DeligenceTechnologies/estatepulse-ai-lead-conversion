import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
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
 * The scheduler is in-process (setTimeout), which means a restart drops every
 * pending step. That is survivable because enrollment is idempotent and the
 * lead watcher re-enrolls anything still untouched — but it is the reason this
 * wants a durable queue before it carries real volume.
 */
const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60000,
  hours: 3600000,
  days: 86400000,
};

const offsetMs = (a: StrategyStep['after']): number => (a?.value ?? 0) * (UNIT_MS[a?.unit] ?? 1000);

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
    const lead = await this.prisma.leads.findUnique({ where: { id: leadId } });
    if (!lead || lead.dnc_status || lead.automation_paused) return;

    // Claim atomically: only the caller that flips first_contact_at from null
    // wins. This closes the race where ingestion and the poll watcher both
    // enroll the same fresh lead (both would otherwise pass the in-memory check).
    const claim = await this.prisma.leads.updateMany({
      where: { id: leadId, first_contact_at: null },
      data: { first_contact_at: new Date() },
    });
    if (claim.count === 0) return;

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

    const enrolledAt = enrollment.enrolledAt;
    for (const step of strategy.steps) {
      const t = setTimeout(
        () => {
          void this.fireStep(enrollment, step, brokerage, tz, strategy.guardrails);
        },
        Math.max(0, enrolledAt + offsetMs(step.after) - Date.now()),
      );
      if (t.unref) t.unref();
      enrollment.timers.push(t);
    }
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
    if (lead.status === 'qualified' || lead.status === 'booked') {
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
        // -> message 'sent', lead 'contacted'
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

    const CONVERTED = ['qualified', 'booked', 'closed', 'lost'];
    if (!CONVERTED.includes(lead.status) && !lead.dnc_status) {
      const why = `Strategy complete after ${e.total} step(s) — ${lead.ai_summary || 'lead not converted'}`;
      await this.activity.exitStrategy(e.leadId, why.slice(0, 2000));
      this.logger.log(`lead ${e.leadId} exited strategy (all ${e.total} steps done, not converted)`);
      await this.enrolOnNegativePath(e.orgId, e.leadId);
    }
    this.stop(e);
  }

  /**
   * Close out a lead the engine was working when the process died.
   *
   * The strategy's schedule lives in `setTimeout`, so a restart drops every
   * pending step. The lead is left holding the engine's claim — `first_contact_at`
   * set, status still new|contacted — and nothing ever comes back for it: the
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

    const CONVERTED = ['qualified', 'booked', 'closed', 'lost'];
    if (CONVERTED.includes(lead.status) || lead.dnc_status) return false;

    const why = `Strategy interrupted — ${lead.ai_summary || 'recovered after a restart'}`;
    await this.activity.exitStrategy(leadId, why.slice(0, 2000));
    this.logger.log(`recovered stranded lead ${leadId} — exited strategy`);
    await this.enrolOnNegativePath(orgId, leadId);
    return true;
  }

  /**
   * The lead worked through every step and never qualified. Hand it to whatever
   * sequence the office pointed at that outcome.
   *
   * This is the path that used to end here. `exitStrategy` above parks the lead
   * in 'nurture' and nothing more, so before this existed a lead who never
   * picked up was marked for follow-up and then never followed up — the leads
   * most in need of a drip were the only ones guaranteed not to get one.
   *
   * Deliberately mirrors qualified(): enrolment must never throw, because the
   * exit itself is already recorded and a lead in nurture without an enrolment
   * can be added by hand, while losing the exit cannot be undone.
   */
  private async enrolOnNegativePath(orgId: string, leadId: string): Promise<void> {
    try {
      const outcomes = await this.negativeOutcomes(orgId, leadId);
      // Most specific first. Several are true at once — someone who never
      // picked up also never replied — so the office's narrowest configured
      // answer wins and 'strategy_completed' stays the catch-all.
      for (const trigger of FollowupService.TRIGGER_PRIORITY) {
        if (!outcomes.has(trigger)) continue;
        const code = await this.followup.sequenceForTrigger(orgId, trigger);
        if (!code) continue;
        await this.followup.enroll(orgId, leadId, code);
        this.logger.log(`lead ${leadId} exited on "${trigger}" — enrolled in ${code}`);
        return;
      }
      this.logger.log(`lead ${leadId} exited strategy — no sequence claims any of its outcomes`);
    } catch (err) {
      this.logger.error(`negative-path enrol ${leadId}: ${(err as Error).message}`);
    }
  }

  /**
   * Which of the negative conditions this lead actually satisfies, read from
   * what was really recorded rather than from what the engine believes it did.
   *
   * In-memory attempt counters would be wrong after a restart, and a lead can
   * be worked by more than one process. The calls and messages on record are
   * the only account that survives both.
   */
  private async negativeOutcomes(orgId: string, leadId: string): Promise<Set<string>> {
    const [calls, lead] = await Promise.all([
      this.prisma.voice_calls.findMany({
        where: { organization_id: orgId, lead_id: leadId },
        select: { status: true },
      }),
      this.prisma.leads.findUnique({
        where: { id: leadId },
        select: { first_response_at: true },
      }),
    ]);

    const out = new Set<string>(['strategy_completed']);
    // 'in_progress' counts as answered: the call connected and the assistant
    // talked to somebody, whatever the webhook managed to record afterwards.
    const answered = calls.some((c) => c.status === 'completed' || c.status === 'in_progress');
    const attempted = calls.length > 0;

    if (attempted && calls.every((c) => c.status === 'failed')) out.add('call_failed');
    else if (attempted && !answered) out.add('no_answer');
    if (answered) out.add('answered_not_qualified');
    if (!lead?.first_response_at) out.add('no_reply');

    return out;
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
   *  - **Status** follows temperature alone. Hot stays `qualified` and waits
   *    for routing to give it an agent; warm and cold go to `nurture`. This is
   *    not conditional on a sequence existing — a warm lead is in nurture
   *    whether or not anybody has configured a drip for it, and tying the two
   *    together made an office with no warm sequence silently mark warm leads
   *    `qualified` and queue them for an agent.
   *  - **Enrolment** follows whatever sequence claims that temperature, which
   *    is now a per-sequence setting an office edits rather than a constant.
   *    Nothing claiming it means nobody is added automatically, which is a
   *    legitimate configuration, not a failure.
   *
   * Warm and cold deliberately get no agent either way: an agent's queue stops
   * being a to-do list the moment every lead is on it.
   */
  async qualified(orgId: string, leadId: string, temperature: string, summary?: string): Promise<void> {
    const isHot = temperature === 'hot';

    await this.prisma.leads.update({
      where: { id: leadId },
      data: {
        status: isHot ? 'qualified' : 'nurture',
        temperature,
        ...(summary ? { ai_summary: summary } : {}),
      },
    });
    const e = this.active.get(leadId);
    if (e) this.stop(e);

    // Enrolment must not fail the webhook: the qualification itself is already
    // recorded, and a lead sitting in nurture without an enrolment can be added
    // by hand. Losing the temperature because a seed query timed out cannot.
    try {
      const code = await this.followup.sequenceForTemperature(orgId, temperature);
      if (!code) {
        this.logger.log(
          `lead ${leadId} qualified as ${temperature} — strategy stopped, no sequence claims that temperature`,
        );
        return;
      }
      await this.followup.enroll(orgId, leadId, code);
      this.logger.log(`lead ${leadId} is ${temperature} — strategy stopped, enrolled in ${code}`);
    } catch (err) {
      this.logger.error(`auto-enrol ${leadId} (${temperature}): ${(err as Error).message}`);
    }
  }
}

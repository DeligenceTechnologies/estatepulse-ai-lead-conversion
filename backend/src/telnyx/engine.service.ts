import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { ConsentStatus, FollowUpReason, LeadStatus, type LeadTemperature, type SequenceTrigger } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { deferredResume, inQuietHours, type QuietHours } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { INACTIVE_STATUSES, IN_STRATEGY_STATUSES, OUTCOME_STATUSES } from '@/lead/lead-status';
import { ActivityService } from './activity.service';
import { SmsService } from './sms.service';
import { StrategyStoreService, offsetMs, type StrategyStep } from './strategy-store.service';
import { VoiceService } from './voice.service';

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
}

/**
 * Runs the outreach strategy for each new lead: the configured SMS and AI call
 * steps on their schedule, held back during quiet hours, stopped the moment
 * the lead replies, books, opts out or reaches any outcome. Enrolment is
 * claimed in the database (first_contact_at), so only one instance ever runs
 * a lead; in-flight leads are resumed after a restart by LeadWatcherService.
 */
@Injectable()
export class EngineService implements OnModuleDestroy {
  private readonly logger = new Logger('Engine');
  private readonly active = new Map<string, Enrollment>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategies: StrategyStoreService,
    private readonly sms: SmsService,
    private readonly voice: VoiceService,
    private readonly activity: ActivityService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
  ) {}

  onModuleDestroy(): void {
    for (const enrollment of this.active.values()) this.halt(enrollment);
    this.active.clear();
  }

  async enroll(orgId: string, leadId: string): Promise<void> {
    if (this.active.has(leadId)) return;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId } });
    if (!lead || lead.dncStatus || lead.automationPaused) return;
    const claim = await this.prisma.lead.updateMany({ where: { id: leadId, firstContactAt: null }, data: { firstContactAt: new Date() } });
    if (claim.count === 0) return;
    await this.prisma.lead.updateMany({ where: { id: leadId, status: LeadStatus.new }, data: { status: LeadStatus.contacting } });

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
    };
    this.active.set(leadId, enrollment);
    this.logger.log(`enrolled lead ${leadId} into "${strategy.name}" — ${strategy.steps.length} steps`);
    this.schedule(enrollment, strategy.steps, office.brokerage, office.timeZone, strategy.guardrails as Guardrails);
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
    };
    this.active.set(leadId, enrollment);
    this.logger.log(`resumed lead ${leadId} — ${remaining.length} of ${enrollment.total} step(s) left`);
    if (remaining.length === 0) this.scheduleFinalize(enrollment);
    else this.schedule(enrollment, remaining, office.brokerage, office.timeZone, strategy.guardrails as Guardrails);
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
      const code =
        (!isHot ? await this.followup.sequenceForTrigger(orgId, `follow_up_${reason}` as SequenceTrigger) : undefined) ??
        (await this.followup.sequenceForTrigger(orgId, `qualified_${temperature}` as SequenceTrigger));
      if (code) await this.followup.enroll(orgId, leadId, code);
    } catch (error) {
      this.logger.error(`auto-enrol ${leadId} (${temperature}): ${(error as Error).message}`);
    }
  }

  async appointmentBooked(orgId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId } });
    if (!lead || INACTIVE_STATUSES.includes(lead.status) || lead.dncStatus) return;
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
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        status,
        ...(reason ? { aiSummary: reason.slice(0, 2000) } : {}),
        ...(status === LeadStatus.follow_up ? { followUpReason: opts.followUpReason ?? FollowUpReason.other } : {}),
        ...(optOut ? { dncStatus: true, automationPaused: true, consentStatus: ConsentStatus.revoked } : {}),
        ...(INACTIVE_STATUSES.includes(status) && reason ? { lostReason: reason.slice(0, 255) } : {}),
      },
    });
    if (!IN_STRATEGY_STATUSES.includes(status)) this.stopFor(leadId);
    if (optOut) await this.followup.stopForLead(orgId, leadId, 'opted_out');
    if (status === LeadStatus.follow_up) await this.enrolOnFollowUp(orgId, leadId);
  }

  isRunning(leadId: string): boolean {
    return this.active.has(leadId);
  }

  private schedule(e: Enrollment, steps: StrategyStep[], brokerage: string, timeZone: string, guardrails: Guardrails): void {
    for (const step of steps) {
      this.later(e, () => this.fireStep(e, step, brokerage, timeZone, guardrails), e.enrolledAt + offsetMs(step.after) - Date.now());
    }
  }

  private async fireStep(e: Enrollment, step: StrategyStep, brokerage: string, timeZone: string, guardrails: Guardrails): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
    if (!lead || lead.dncStatus || lead.automationPaused || OUTCOME_STATUSES.includes(lead.status)) return this.stop(e);

    if (guardrails?.respectQuietHours !== false && inQuietHours(timeZone, guardrails?.quietHours)) {
      const now = Date.now();
      const { shift, resumeAt } = deferredResume({
        timeZone,
        quiet: guardrails.quietHours,
        now,
        enrolledAt: e.enrolledAt,
        offset: offsetMs(step.after),
        shift: e.quietShift,
      });
      e.quietShift = shift;
      this.later(e, () => this.fireStep(e, step, brokerage, timeZone, guardrails), resumeAt - now);
      return;
    }

    const firstName = lead.firstName?.trim() || 'there';
    if (step.channel === 'sms') {
      const text = (step.message ?? '').replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{brokerage\}\}/g, brokerage);
      try {
        const sent = await this.sms.sendSms(e.orgId, lead.phone ?? '', text);
        await this.activity.recordSms(e.orgId, e.leadId, text, true, sent.id);
      } catch (error) {
        await this.activity.recordSms(e.orgId, e.leadId, text, false, (error as Error).message);
      }
    } else if (step.channel === 'voice' && (guardrails?.maxVoiceAttempts ?? 99) > e.voiceAttempts) {
      e.voiceAttempts += 1;
      try {
        const call = await this.voice.placeCall(e.orgId, lead.phone ?? '', { leadId: e.leadId, orgId: e.orgId });
        await this.activity.startCall(e.orgId, e.leadId, call.call_control_id);
      } catch (error) {
        await this.activity.recordCallFailed(e.orgId, e.leadId, (error as Error).message);
      }
    }
    e.ran += 1;
    if (e.ran >= e.total) this.scheduleFinalize(e);
  }

  private scheduleFinalize(e: Enrollment): void {
    this.later(e, () => this.finalize(e), FINALIZE_AFTER_MS);
  }

  private async finalize(e: Enrollment): Promise<void> {
    if (e.stopped) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: e.leadId } });
    if (lead && !OUTCOME_STATUSES.includes(lead.status) && !lead.dncStatus) {
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

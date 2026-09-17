import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
  ) {}

  /** Clear every pending timer so a shutdown does not fire steps mid-teardown. */
  onModuleDestroy(): void {
    for (const enrollment of this.active.values()) {
      enrollment.stopped = true;
      enrollment.timers.forEach(clearTimeout);
    }
    this.active.clear();
  }

  /** Is `now` inside the org's quiet-hours window (org timezone)? */
  private inQuietHours(tz: string, quiet?: { start: string; end: string }): boolean {
    if (!quiet) return false;
    const hhmm = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const [h = 0, m = 0] = hhmm.split(':').map(Number);
    const now = h * 60 + m;
    const [sh = 0, sm = 0] = quiet.start.split(':').map(Number);
    const [eh = 0, em = 0] = quiet.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start > end ? now >= start || now < end : now >= start && now < end;
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

    const enrollment: Enrollment = { orgId, leadId, voiceAttempts: 0, timers: [], stopped: false };
    this.active.set(leadId, enrollment);
    this.logger.log(
      `enrolled lead ${leadId} (${lead.first_name ?? ''}) into "${strategy.name}" — ${strategy.steps.length} steps`,
    );

    const enrolledAt = Date.now();
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

    // Quiet-hours: defer to the next allowed window.
    if (guardrails?.respectQuietHours !== false && this.inQuietHours(tz, guardrails?.quietHours)) {
      const t = setTimeout(
        () => {
          void this.fireStep(e, step, brokerage, tz, guardrails);
        },
        15 * 60 * 1000,
      );
      if (t.unref) t.unref();
      e.timers.push(t);
      this.logger.log(`deferred ${step.channel} for lead ${e.leadId} (quiet hours)`);
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
        // -> message 'failed', lead unchanged
        await this.activity.recordSms(e.orgId, e.leadId, text, false);
        this.logger.warn(`SMS FAILED for lead ${e.leadId}: ${(err as Error).message}`);
      }
    } else if (step.channel === 'voice') {
      if ((guardrails?.maxVoiceAttempts ?? 99) <= e.voiceAttempts) {
        this.logger.log(`skip call (max attempts) lead ${e.leadId}`);
        return;
      }
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
        await this.activity.recordCallFailed(e.orgId, e.leadId); // -> voice_call 'failed'
        this.logger.warn(`call FAILED for lead ${e.leadId}: ${(err as Error).message}`);
      }
    }
  }

  private stop(e: Enrollment): void {
    e.stopped = true;
    e.timers.forEach(clearTimeout);
    this.active.delete(e.leadId);
  }

  /**
   * Called when the AI call qualifies the lead — ends the strategy and records
   * the temperature.
   */
  async qualified(orgId: string, leadId: string, temperature: string, summary?: string): Promise<void> {
    await this.prisma.leads.update({
      where: { id: leadId },
      data: { status: 'qualified', temperature, ...(summary ? { ai_summary: summary } : {}) },
    });
    const e = this.active.get(leadId);
    if (e) this.stop(e);
    this.logger.log(`lead ${leadId} qualified as ${temperature} — strategy stopped, handed off`);
  }
}

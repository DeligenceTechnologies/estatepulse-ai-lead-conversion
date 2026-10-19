import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnrollmentStatus, LeadStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { nextAllowedAt } from '@/common/utils/quiet-hours';
import { OUTCOME_STATUSES } from '@/lead/lead-status';
import { ActivityService } from '@/telnyx/activity.service';
import { SmsService } from '@/telnyx/sms.service';
import { CallQueue } from '@/telnyx/calls/call.queue';
import { FollowupService, stepsOf, type SequenceStep } from './followup.service';

interface ClaimedEnrollment {
  id: string;
  organization_id: string;
  lead_id: string;
  sequence_id: string;
  current_step: number;
  attempts: number;
}

const MAX_ATTEMPTS = 6;

/**
 * Sends the sequence step each due enrolment is on. Claims with FOR UPDATE
 * SKIP LOCKED so several instances share the queue, re-checks the lead before
 * every send, defers into the next allowed hour, and retries with backoff.
 */
@Injectable()
export class FollowupRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FollowupRunner.name);
  private readonly instanceId = `followup-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<IntegrationEnv, true>,
    private readonly followup: FollowupService,
    private readonly sms: SmsService,
    private readonly calls: CallQueue,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('STRATEGY_ENGINE', { infer: true })) return;
    this.timer = setInterval(() => void this.tick(), this.config.get('FOLLOWUP_POLL_MS', { infer: true }));
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inFlight) await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, 5000).unref())]).catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        await this.requeueStuck();
        for (const row of await this.claim()) {
          if (this.stopped) break;
          await this.execute(row);
        }
      } catch (error) {
        this.logger.error(`Follow-up tick failed: ${(error as Error).message}`);
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.running = false;
      this.inFlight = null;
    }
  }

  private claim(): Promise<ClaimedEnrollment[]> {
    const batch = this.config.get('FOLLOWUP_BATCH_SIZE', { infer: true });
    return this.prisma.$queryRaw<ClaimedEnrollment[]>`
      WITH claimed AS (
        SELECT id FROM sequence_enrollments
         WHERE status = 'active' AND locked_by IS NULL AND next_action_at IS NOT NULL AND next_action_at <= now()
         ORDER BY next_action_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${batch}
      )
      UPDATE sequence_enrollments e
         SET locked_by = ${this.instanceId}, locked_at = now(), attempts = e.attempts + 1
        FROM claimed
       WHERE e.id = claimed.id
      RETURNING e.id, e.organization_id, e.lead_id, e.sequence_id, e.current_step, e.attempts`;
  }

  private async requeueStuck(): Promise<void> {
    const stuckMs = this.config.get('FOLLOWUP_STUCK_AFTER_MS', { infer: true });
    await this.prisma.$executeRaw`
      UPDATE sequence_enrollments SET locked_by = NULL, locked_at = NULL
       WHERE locked_by IS NOT NULL AND locked_at < now() - make_interval(secs => ${stuckMs / 1000})`;
  }

  private async execute(row: ClaimedEnrollment): Promise<void> {
    try {
      const lead = await this.prisma.lead.findUnique({
        where: { id: row.lead_id },
        select: { firstName: true, phone: true, status: true, dncStatus: true, automationPaused: true },
      });
      if (!lead) return void (await this.finish(row.id, EnrollmentStatus.stopped, 'lead_deleted'));
      if (lead.dncStatus) return void (await this.finish(row.id, EnrollmentStatus.stopped, 'opted_out'));
      if (lead.automationPaused) return void (await this.pause(row.id));
      if (OUTCOME_STATUSES.includes(lead.status)) return void (await this.finish(row.id, EnrollmentStatus.stopped, `lead_${lead.status}`));

      const sequence = await this.prisma.sequence.findUnique({ where: { id: row.sequence_id }, select: { steps: true } });
      const steps = sequence ? stepsOf(sequence) : [];
      const step = steps[row.current_step - 1];
      if (!step) return void (await this.finish(row.id, EnrollmentStatus.completed, 'exhausted'));

      const { timeZone, quiet } = await this.followup.guardrailsFor(row.organization_id);
      const now = new Date();
      const allowed = nextAllowedAt(timeZone, quiet, now);
      if (allowed > now) {
        await this.prisma.sequenceEnrollment.update({ where: { id: row.id }, data: { nextActionAt: allowed, lockedBy: null, lockedAt: null } });
        return;
      }
      await this.fire(row, step, lead);
      await this.advance(row, steps);
    } catch (error) {
      await this.onFailure(row, (error as Error).message);
    }
  }

  private async fire(row: ClaimedEnrollment, step: SequenceStep, lead: { firstName: string | null; phone: string | null }): Promise<void> {
    if (step.actionType === 'sms') {
      const org = await this.prisma.organization.findUnique({ where: { id: row.organization_id }, select: { name: true } });
      const text = String(step.messageTemplate ?? '')
        .replace(/\{\{firstName\}\}/g, lead.firstName?.trim() || 'there')
        .replace(/\{\{brokerage\}\}/g, org?.name ?? 'our team');
      if (!text) return;
      try {
        const sent = await this.sms.sendSms(row.organization_id, lead.phone ?? '', text);
        await this.activity.recordSms(row.organization_id, row.lead_id, text, true, sent.id);
      } catch (error) {
        await this.activity.recordSms(row.organization_id, row.lead_id, text, false, (error as Error).message);
      }
      return;
    }
    try {
      await this.calls.enqueue(
        { orgId: row.organization_id, leadId: row.lead_id, source: 'followup', sequenceId: row.sequence_id },
        { dedupeKey: `followup:${row.id}:${row.current_step}` },
      );
    } catch (error) {
      await this.activity.recordCallFailed(row.organization_id, row.lead_id, (error as Error).message);
    }
  }

  /** After the last step a lead that never responded is closed out as not interested. */
  private async advance(row: ClaimedEnrollment, steps: SequenceStep[]): Promise<void> {
    const next = steps[row.current_step];
    if (!next) {
      await this.finish(row.id, EnrollmentStatus.completed, 'exhausted');
      await this.prisma.lead.updateMany({
        where: { id: row.lead_id, status: LeadStatus.follow_up },
        data: { status: LeadStatus.not_interested, lostReason: 'Follow-up sequence exhausted with no response' },
      });
      return;
    }
    await this.prisma.sequenceEnrollment.update({
      where: { id: row.id },
      data: {
        currentStep: row.current_step + 1,
        nextActionAt: await this.followup.dueAt(row.organization_id, next.delayMinutes),
        lockedBy: null,
        lockedAt: null,
        lastError: null,
      },
    });
  }

  private finish(id: string, status: EnrollmentStatus, reason: string) {
    return this.prisma.sequenceEnrollment.update({
      where: { id },
      data: {
        status,
        nextActionAt: null,
        lockedBy: null,
        lockedAt: null,
        ...(status === EnrollmentStatus.completed ? { completedAt: new Date() } : { stoppedAt: new Date(), stoppedReason: reason }),
      },
    });
  }

  private pause(id: string) {
    return this.prisma.sequenceEnrollment.update({
      where: { id },
      data: { status: EnrollmentStatus.paused, nextActionAt: null, lockedBy: null, lockedAt: null },
    });
  }

  private async onFailure(row: ClaimedEnrollment, message: string): Promise<void> {
    const dead = row.attempts >= MAX_ATTEMPTS;
    this.logger.warn(`enrolment ${row.id} attempt ${row.attempts} failed${dead ? ', giving up' : ''}: ${message}`);
    await this.prisma.sequenceEnrollment
      .update({
        where: { id: row.id },
        data: dead
          ? { status: EnrollmentStatus.stopped, stoppedAt: new Date(), stoppedReason: 'failed', nextActionAt: null, lastError: message.slice(0, 2000), lockedBy: null, lockedAt: null }
          : { nextActionAt: new Date(Date.now() + Math.min(2 ** row.attempts, 60) * 60_000), lastError: message.slice(0, 2000), lockedBy: null, lockedAt: null },
      })
      .catch(() => undefined);
  }
}

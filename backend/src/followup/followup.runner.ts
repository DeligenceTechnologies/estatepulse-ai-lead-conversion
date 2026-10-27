import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallDisposition, CallStatus, EnrollmentStatus, LeadStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { nextContactAt } from '@/common/utils/quiet-hours';
import { LeadStateService } from '@/lead/lead-state.service';
import { OUTCOME_STATUSES } from '@/lead/lead-status';
import { ActivityService } from '@/telnyx/activity.service';
import { SmsService } from '@/telnyx/sms.service';
import { CallQueue } from '@/telnyx/calls/call.queue';
import { SmsConversationService } from '@/telnyx/sms/sms-conversation.service';
import { fillTemplate } from '@/telnyx/template';
import { FollowupService, stepsOf, type SequenceStep } from './followup.service';
import { unmetCondition, type JourneyFacts } from './journey';

interface ClaimedEnrollment {
  id: string;
  organization_id: string;
  lead_id: string;
  sequence_id: string;
  current_step: number;
  attempts: number;
  enrolled_at: Date;
}

const MAX_ATTEMPTS = 6;
/** How long a lead has to answer the last step before the sequence closes it out. */
export const CLOSE_OUT_AFTER_MS = 48 * 3_600_000;
/** How long after a lead's last text the next sequence step waits, so it never lands in the middle of a chat. */
export const CHAT_QUIET_MS = 30 * 60_000;
/** A step after a call that is still queued, ringing or live looks again this soon. */
export const CALL_HOLD_RECHECK_MS = 30_000;
/** A call still not over after this is a lost hangup or a stuck queue: the next step goes ahead. */
export const CALL_HOLD_MAX_MS = 30 * 60_000;

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
    private readonly state: LeadStateService,
    private readonly conversations: SmsConversationService,
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
      RETURNING e.id, e.organization_id, e.lead_id, e.sequence_id, e.current_step, e.attempts, e.enrolled_at`;
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
      if (!step && steps.length > 0 && row.current_step > steps.length) return void (await this.closeOut(row));
      if (!step) return void (await this.finish(row.id, EnrollmentStatus.completed, 'exhausted'));

      // A lead texting with the AI is not sent the next step until the chat has been quiet a while.
      const lastReply = await this.prisma.message.findFirst({
        where: { leadId: row.lead_id, channel: 'sms', direction: 'inbound' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const chatQuietAt = lastReply ? lastReply.createdAt.getTime() + CHAT_QUIET_MS : 0;
      if (chatQuietAt > Date.now()) {
        await this.prisma.sequenceEnrollment.update({ where: { id: row.id }, data: { nextActionAt: new Date(chatQuietAt), lockedBy: null, lockedAt: null } });
        return;
      }

      const { timeZone, quiet, skipDays } = await this.followup.guardrailsFor(row.organization_id);
      const now = new Date();
      const allowed = nextContactAt(timeZone, quiet, skipDays, now);
      if (allowed > now) return void (await this.deferTo(row, allowed));

      // As in the strategy: nothing over a call that is not over, and nothing canned after a conversation.
      const journey = await this.journeyState(row);
      if (journey.callOpen) return void (await this.deferTo(row, new Date(Date.now() + CALL_HOLD_RECHECK_MS)));
      const event = { orgId: row.organization_id, leadId: row.lead_id, source: 'followup', channel: step.actionType, payload: { sequenceId: row.sequence_id, step: row.current_step } };
      if (journey.lastCall === CallDisposition.connected) {
        this.state.quietly({ ...event, type: 'sequence_stopped', reason: 'The lead talked on a call; the call scoring decides what comes next' });
        return void (await this.finish(row.id, EnrollmentStatus.stopped, 'lead_talked'));
      }
      const unmet = unmetCondition(step.onlyIf, journey);
      if (unmet) {
        this.state.quietly({ ...event, type: 'step_skipped', reason: unmet });
        return void (await this.advance(row, steps));
      }
      // The day's limit or the gap since our last touch on this channel: the step waits, it is not dropped.
      const slot = await this.followup.contactSlot(row.organization_id, row.lead_id, step.actionType);
      if (slot.at > now) {
        this.state.quietly({ ...event, type: 'step_held', reason: slot.reason });
        return void (await this.deferTo(row, slot.at));
      }
      await this.fire(row, step, lead);
      await this.advance(row, steps);
    } catch (error) {
      await this.onFailure(row, (error as Error).message);
    }
  }

  private deferTo(row: ClaimedEnrollment, at: Date) {
    return this.prisma.sequenceEnrollment.update({ where: { id: row.id }, data: { nextActionAt: at, lockedBy: null, lockedAt: null } });
  }

  /**
   * The calls and texts since this enrolment began: whether a call it placed
   * is still queued, ringing or live (up to CALL_HOLD_MAX_MS), how the last
   * call ended, whether the lead has texted back, and whether the step before
   * this one was skipped.
   */
  private async journeyState(row: ClaimedEnrollment): Promise<JourneyFacts & { callOpen: boolean }> {
    const since = new Date(row.enrolled_at);
    const holdFrom = new Date(Date.now() - CALL_HOLD_MAX_MS);
    const [latest, queued, reply, lastStep] = await Promise.all([
      this.prisma.call.findFirst({
        where: { leadId: row.lead_id, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { status: true, disposition: true, endedAt: true, createdAt: true },
      }),
      this.prisma.leadEvent.findFirst({
        where: { leadId: row.lead_id, source: 'followup', type: 'step_sent', channel: 'voice', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.message.findFirst({ where: { leadId: row.lead_id, channel: 'sms', direction: 'inbound', createdAt: { gte: since } }, select: { id: true } }),
      this.prisma.leadEvent.findFirst({
        where: { leadId: row.lead_id, source: 'followup', type: { in: ['step_sent', 'step_skipped', 'step_failed'] }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { type: true, payload: true },
      }),
    ]);
    const live = !!latest && (latest.status === CallStatus.ringing || latest.status === CallStatus.in_progress) && latest.createdAt >= holdFrom;
    // A call we queued that has not been placed yet (waiting for a slot, quiet hours or the redial gap).
    const notPlaced = !!queued && queued.createdAt >= holdFrom && (!latest || latest.createdAt < queued.createdAt);
    const logged = lastStep?.payload as { sequenceId?: string; step?: number } | null | undefined;
    const previousSkipped = lastStep?.type === 'step_skipped' && logged?.sequenceId === row.sequence_id && logged?.step === row.current_step - 1;
    return { callOpen: live || notPlaced, lastCall: latest?.endedAt ? (latest.disposition ?? null) : null, replied: !!reply, previousSkipped };
  }

  private async fire(row: ClaimedEnrollment, step: SequenceStep, lead: { firstName: string | null; phone: string | null }): Promise<void> {
    const event = {
      orgId: row.organization_id,
      leadId: row.lead_id,
      source: 'followup',
      channel: step.actionType,
      payload: { sequenceId: row.sequence_id, step: row.current_step },
    };
    if (step.actionType === 'sms') {
      const [org, variables] = await Promise.all([
        this.prisma.organization.findUnique({ where: { id: row.organization_id }, select: { name: true } }),
        this.activity.leadVariables(row.organization_id, row.lead_id),
      ]);
      const text = fillTemplate(String(step.messageTemplate ?? ''), { ...variables, firstName: lead.firstName?.trim() || 'there', brokerage: org?.name ?? 'our team' });
      if (!text) return;
      try {
        const sent = await this.sms.sendSms(row.organization_id, lead.phone ?? '', text);
        await this.activity.recordSms(row.organization_id, row.lead_id, text, true, sent.id);
        this.state.quietly({ ...event, type: 'step_sent' });
        this.conversations
          .appendOurMessage(row.organization_id, lead.phone, text)
          .catch((error) => this.logger.warn(`lead ${row.lead_id}: adding our text to the AI chat failed: ${(error as Error).message}`));
      } catch (error) {
        await this.activity.recordSms(row.organization_id, row.lead_id, text, false, (error as Error).message);
        this.state.quietly({ ...event, type: 'step_failed', reason: (error as Error).message });
      }
      return;
    }
    try {
      await this.calls.enqueue(
        {
          orgId: row.organization_id,
          leadId: row.lead_id,
          source: 'followup',
          sequenceId: row.sequence_id,
          ...(step.voicemail && step.voicemail !== 'default' ? { voicemail: step.voicemail } : {}),
          ...(step.voicePrompt?.trim() ? { context: step.voicePrompt.trim() } : {}),
        },
        { dedupeKey: `followup:${row.id}:${row.current_step}` },
      );
      this.state.quietly({ ...event, type: 'step_sent', reason: 'Call queued' });
    } catch (error) {
      await this.activity.recordCallFailed(row.organization_id, row.lead_id, (error as Error).message);
      this.state.quietly({ ...event, type: 'step_failed', reason: (error as Error).message });
    }
  }

  /**
   * Moves to the next step. After the last one the enrolment stays live, one
   * past the end, for CLOSE_OUT_AFTER_MS: the lead can still answer, book or be
   * called on that last step before closeOut runs.
   */
  private async advance(row: ClaimedEnrollment, steps: SequenceStep[]): Promise<void> {
    const next = steps[row.current_step];
    if (!next) {
      await this.prisma.sequenceEnrollment.update({
        where: { id: row.id },
        data: {
          currentStep: row.current_step + 1,
          nextActionAt: new Date(Date.now() + CLOSE_OUT_AFTER_MS),
          lockedBy: null,
          lockedAt: null,
          lastError: null,
        },
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

  /**
   * Every step ran and the lead stayed silent through the wait after the last
   * one: closed out as unresponsive. A lead who replied or talked on a call
   * since the enrolment began did respond, so the sequence just completes.
   */
  private async closeOut(row: ClaimedEnrollment): Promise<void> {
    const journey = await this.journeyState(row);
    if (journey.replied || journey.lastCall === CallDisposition.connected) {
      return void (await this.finish(row.id, EnrollmentStatus.completed, 'lead_responded'));
    }
    const reason = 'Follow-up sequence exhausted with no response';
    await this.prisma.$transaction(async (tx) => {
      await this.finish(row.id, EnrollmentStatus.completed, 'exhausted', tx);
      await this.state.move(row.lead_id, LeadStatus.unresponsive, { source: 'followup', reason, data: { lostReason: reason } }, tx);
    });
  }

  private finish(id: string, status: EnrollmentStatus, reason: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.sequenceEnrollment.update({
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

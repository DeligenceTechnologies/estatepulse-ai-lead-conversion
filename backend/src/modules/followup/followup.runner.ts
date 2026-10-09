import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { nextAllowedAt } from '../../common/quiet-hours';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityService } from '../../telnyx/activity.service';
import { SmsService } from '../../telnyx/sms.service';
import { VoiceService } from '../../telnyx/voice.service';
import { FollowupService } from './followup.service';
import { FOLLOW_UP_STATUSES, LeadStatus, OUTCOME_STATUSES, normalizeLeadStatus } from '../../common/domain';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ClaimedEnrollment {
  id: string;
  organization_id: string;
  lead_id: string;
  sequence_id: string;
  current_step: number;
  attempts: number;
}

/**
 * Fires nurture steps off the database.
 *
 * Deliberately NOT the strategy engine's scheduler. That one holds its steps in
 * `setTimeout`, which is defensible for an engagement cadence measured in
 * minutes and indefensible here: a deploy on Tuesday would silently cancel
 * every follow-up scheduled for the rest of the month, and nothing would
 * rebuild them. Nothing in this class survives a restart, and nothing needs to
 * — the queue is `sequence_enrollments.next_action_at`, and a fresh process
 * picks up exactly where the old one stopped.
 *
 * The claim pattern is copied from ProcessingWorker rather than reinvented:
 * claim in a short transaction with FOR UPDATE SKIP LOCKED, do the work
 * outside it, requeue rows whose lock went stale. Any number of instances can
 * poll concurrently without a coordinator, and no lead is ever texted twice
 * because two instances both thought a step was due.
 */
@Injectable()
export class FollowupRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FollowupRunner.name);
  private readonly instanceId = randomUUID();
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    // Unguarded by design, exactly as ProcessingWorker is: this sweeper claims
    // due enrolments across EVERY tenant in one raw UPDATE ... RETURNING, so
    // there is no single organization id to scope it by. Each claimed row then
    // carries its own organization_id, which the work below stays inside.
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly followup: FollowupService,
    private readonly sms: SmsService,
    private readonly voice: VoiceService,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit(): void {
    // Shares the strategy engine's opt-in switch. One flag decides whether this
    // deployment is allowed to contact real people at all; a runner that fired
    // texts while the engine was off would be a nasty surprise on a shared
    // development database.
    if (this.config.get('STRATEGY_ENGINE') !== '1') {
      this.logger.log('Follow-up runner disabled (STRATEGY_ENGINE is not "1")');
      return;
    }
    const interval = Number(this.config.get('FOLLOWUP_POLL_MS') ?? 60_000);
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(
      `Follow-up runner started (poll ${interval}ms, instance ${this.instanceId.slice(0, 8)})`,
    );
  }

  /** Let the tick already in flight finish, so a deploy does not abandon a claimed row. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inFlight) {
      await Promise.race([
        this.inFlight,
        new Promise((r) => setTimeout(r, 5000).unref?.()),
      ]).catch(() => undefined);
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        await this.requeueStuck();
        const claimed = await this.claim();
        for (const row of claimed) {
          if (this.stopped) break;
          await this.execute(row);
        }
      } catch (err) {
        this.logger.error(`Follow-up tick failed: ${String(err)}`);
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.running = false;
      this.inFlight = null;
    }
  }

  /**
   * Claim due enrolments by taking the lock, NOT by moving the status.
   *
   * ProcessingWorker can flip `queue_state` because that column is a queue
   * state and nothing else. `sequence_enrollments.status` is a domain state —
   * it is what the Follow-ups screen shows and what
   * `sequence_enrollments_status_check` constrains to
   * active|paused|completed|stopped. Writing 'processing' into it would both
   * violate that constraint and leak a scheduling detail into the thing a
   * person reads. `locked_by` is the queue state; the two stay separate.
   *
   * `next_action_at` is deliberately left alone, so a crash between here and
   * execute() re-runs the step rather than skipping it.
   */
  private async claim(): Promise<ClaimedEnrollment[]> {
    const batch = Number(this.config.get('FOLLOWUP_BATCH_SIZE') ?? 20);
    return this.prisma.$queryRawUnsafe<ClaimedEnrollment[]>(
      `WITH claimed AS (
         SELECT id FROM sequence_enrollments
          WHERE status = 'active'
            AND locked_by IS NULL
            AND next_action_at IS NOT NULL
            AND next_action_at <= now()
          ORDER BY next_action_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE sequence_enrollments e
          SET locked_by = $2::uuid, locked_at = now(), attempts = e.attempts + 1
         FROM claimed
        WHERE e.id = claimed.id
       RETURNING e.id, e.organization_id, e.lead_id, e.sequence_id, e.current_step, e.attempts`,
      batch,
      this.instanceId,
    );
  }

  /**
   * A process killed mid-step leaves a row claimed forever. Returning it to
   * 'active' costs a few minutes of delay; leaving it costs the rest of the
   * lead's sequence.
   */
  private async requeueStuck(): Promise<void> {
    const ms = Number(this.config.get('FOLLOWUP_STUCK_AFTER_MS') ?? 600_000);
    await this.prisma.$executeRawUnsafe(
      `UPDATE sequence_enrollments
          SET locked_by = NULL, locked_at = NULL
        WHERE locked_by IS NOT NULL
          AND locked_at < now() - ($1 || ' milliseconds')::interval`,
      String(ms),
    );
  }

  /**
   * Run one step, then decide where the enrolment goes next.
   *
   * Every exit path writes a terminal or a future state. An enrolment left in
   * 'processing' is a lead who silently stops hearing from us, so the catch at
   * the bottom is not optional.
   */
  private async execute(row: ClaimedEnrollment): Promise<void> {
    try {
      const lead = await this.prisma.leads.findUnique({
        where: { id: row.lead_id },
        select: {
          id: true,
          first_name: true,
          phone: true,
          status: true,
          dnc_status: true,
          automation_paused: true,
        },
      });

      // The stop conditions, checked at fire time rather than trusted from
      // enrolment: days have passed since we last looked.
      if (!lead) return void (await this.finish(row.id, 'stopped', 'lead_deleted'));
      if (lead.dnc_status) return void (await this.finish(row.id, 'stopped', 'opted_out'));
      if (lead.automation_paused) return void (await this.pause(row.id));
      // Any outcome ends the drip (OUTCOME_STATUSES, legacy spellings included).
      if (OUTCOME_STATUSES.includes(lead.status)) {
        return void (await this.finish(row.id, 'stopped', `lead_${normalizeLeadStatus(lead.status)}`));
      }

      const step = await this.prisma.sequence_steps.findFirst({
        where: { sequence_id: row.sequence_id, step_order: row.current_step },
      });
      if (!step) return void (await this.finish(row.id, 'completed', 'exhausted'));

      const { tz, quiet } = await this.followup.guardrailsFor(row.organization_id);

      // Compliance gate. A step due at 3am is deferred to the start of the next
      // allowed window, never dropped — and because that is a column and not a
      // timer, the deferral survives a restart too.
      const now = new Date();
      const allowed = nextAllowedAt(tz, quiet, now);
      if (allowed.getTime() > now.getTime()) {
        await this.prisma.sequence_enrollments.update({
          where: { id: row.id },
          data: { next_action_at: allowed, locked_by: null, locked_at: null },
        });
        this.logger.log(`deferred step ${row.current_step} for lead ${row.lead_id} (quiet hours)`);
        return;
      }

      await this.fire(row, step, lead);
      await this.advance(row);
    } catch (e) {
      await this.onFailure(row, (e as Error).message);
    }
  }

  private async fire(row: ClaimedEnrollment, step: any, lead: any): Promise<void> {
    const org = await this.prisma.organizations.findUnique({
      where: { id: row.organization_id },
      select: { name: true },
    });
    const firstName = (lead.first_name ?? '').trim() || 'there';
    const brokerage = org?.name ?? 'our team';

    if (step.action_type === 'sms') {
      const text = String(step.message_template ?? '')
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/\{\{brokerage\}\}/g, brokerage);
      if (!text) return;
      try {
        const r: any = await this.sms.sendSms(row.organization_id, lead.phone ?? '', text);
        await this.activity.recordSms(row.organization_id, row.lead_id, text, true, r?.id);
        this.logger.log(`nurture SMS sent to lead ${row.lead_id} (step ${row.current_step})`);
      } catch (err) {
        // Recorded as a failed message, but the sequence continues: one
        // undelivered text is not a reason to abandon a six-week nurture.
        await this.activity.recordSms(
          row.organization_id,
          row.lead_id,
          text,
          false,
          (err as Error).message,
        );
        this.logger.warn(`nurture SMS failed for lead ${row.lead_id}: ${(err as Error).message}`);
      }
      return;
    }

    if (step.action_type === 'voice') {
      try {
        const r: any = await this.voice.placeCall(row.organization_id, lead.phone ?? '', {
          leadId: row.lead_id,
          orgId: row.organization_id,
          sequenceId: row.sequence_id,
        });
        await this.activity.startCall(row.organization_id, row.lead_id, r?.call_control_id);
        this.logger.log(`nurture call dialed to lead ${row.lead_id} (step ${row.current_step})`);
      } catch (err) {
        await this.activity.recordCallFailed(
          row.organization_id,
          row.lead_id,
          (err as Error).message,
        );
        this.logger.warn(`nurture call failed for lead ${row.lead_id}: ${(err as Error).message}`);
      }
    }
  }

  /** Move to the next step, or complete the sequence if that was the last one. */
  private async advance(row: ClaimedEnrollment): Promise<void> {
    const next = await this.prisma.sequence_steps.findFirst({
      where: { sequence_id: row.sequence_id, step_order: { gt: row.current_step } },
      orderBy: { step_order: 'asc' },
    });

    if (!next) {
      await this.finish(row.id, 'completed', 'exhausted');
      // A lead that ran the whole sequence without responding is done, not
      // in limbo: the spec's rule is that a lead leaves nurture upwards or out,
      // and a sequence with no end is how you get a TCPA complaint.
      await this.prisma.leads.updateMany({
        where: { id: row.lead_id, status: { in: FOLLOW_UP_STATUSES } },
        data: { status: LeadStatus.NOT_INTERESTED, lost_reason: 'Follow-up sequence exhausted with no response' },
      });
      this.logger.log(`lead ${row.lead_id} exhausted its sequence — marked not_interested`);
      return;
    }

    const { tz, quiet } = await this.followup.guardrailsFor(row.organization_id);
    const due = nextAllowedAt(tz, quiet, new Date(Date.now() + next.delay_minutes * 60_000));

    await this.prisma.sequence_enrollments.update({
      where: { id: row.id },
      data: {
        status: 'active',
        current_step: next.step_order,
        next_action_at: due,
        locked_by: null,
        locked_at: null,
        last_error: null,
      },
    });
  }

  private async finish(id: string, status: 'completed' | 'stopped', reason: string): Promise<void> {
    await this.prisma.sequence_enrollments.update({
      where: { id },
      data: {
        status,
        next_action_at: null,
        locked_by: null,
        locked_at: null,
        ...(status === 'completed' ? { completed_at: new Date() } : {}),
        ...(status === 'stopped' ? { stopped_at: new Date(), stopped_reason: reason } : {}),
      },
    });
  }

  /**
   * The lead is mid-conversation with a human. Paused rather than stopped: the
   * conversation may go quiet, and a person can put them back in.
   */
  private async pause(id: string): Promise<void> {
    await this.prisma.sequence_enrollments.update({
      where: { id },
      data: { status: 'paused', next_action_at: null, locked_by: null, locked_at: null },
    });
  }

  /**
   * Back off and retry, then give up.
   *
   * Six attempts matches ProcessingWorker's dead-letter threshold. Giving up is
   * recorded on the row with the error, so "why did this lead stop getting
   * texts" is answerable without reading logs.
   */
  private async onFailure(row: ClaimedEnrollment, message: string): Promise<void> {
    const MAX = 6;
    if (row.attempts >= MAX) {
      this.logger.error(
        `enrolment ${row.id} failed ${row.attempts} times, giving up: ${message}`,
      );
      await this.prisma.sequence_enrollments
        .update({
          where: { id: row.id },
          data: {
            status: 'stopped',
            stopped_at: new Date(),
            stopped_reason: 'failed',
            next_action_at: null,
            last_error: message.slice(0, 2000),
            locked_by: null,
            locked_at: null,
          },
        })
        .catch(() => undefined);
      return;
    }

    const backoffMs = Math.min(2 ** row.attempts, 60) * 60_000;
    this.logger.warn(`enrolment ${row.id} attempt ${row.attempts} failed, retrying: ${message}`);
    await this.prisma.sequence_enrollments
      .update({
        where: { id: row.id },
        data: {
          status: 'active',
          next_action_at: new Date(Date.now() + backoffMs),
          last_error: message.slice(0, 2000),
          locked_by: null,
          locked_at: null,
        },
      })
      .catch(() => undefined);
  }
}

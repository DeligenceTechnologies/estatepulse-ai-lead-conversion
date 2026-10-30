import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallDisposition, CallStatus, EnrollmentStatus, LeadStatus } from '@prisma/client';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { CallingProviders, type CallingProvider } from '@/calling/calling-providers';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { QueueEnv } from '@/common/utils/interface';
import { nextAllowedAt, nextContactAt } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { IN_STRATEGY_STATUSES, OUTCOME_STATUSES } from '@/lead/lead-status';
import { hasUpcomingMeeting } from '@/lead/upcoming-meeting';
import { CALL_QUEUE, CallJob } from '@/queue/queue.constants';
import { ActivityService } from '../activity.service';
import { CallSlots } from './call-slots';
import { DEFAULT_CALL_LIMIT, type CallIntent, type CallJobData } from './call.types';

const LIMIT_CACHE_MS = 30_000;
const SLOT_WAIT_MS = 5_000;
const SLOT_WAIT_JITTER_MS = 5_000;
/** A callback due while the lead is still on our previous call waits this long and looks again. */
const LIVE_CALL_WAIT_MS = 30_000;
/** A call row older than this still marked live is a lost hangup, not a call in progress. */
const LIVE_CALL_MAX_AGE_MS = 30 * 60_000;
/** Telnyx or the network failing the dial (not the lead, not the number) is tried once more after this. */
export const DIAL_RETRY_MS = 10 * 60_000;

/** A callback the lead asked for is kept even after a hot result: the AI promised it. */
const CALLBACK_BLOCKED = OUTCOME_STATUSES.filter((s) => s !== LeadStatus.interested && s !== LeadStatus.appointment_requested);

export function isCapacityError(message: string): boolean {
  return /failed 429|channel limit|concurrent call|too many/i.test(message);
}

/** Telnyx unreachable, or failing on its side: the dial may work a little later. */
export function isTransientDialError(message: string): boolean {
  return /(?:Telnyx|Retell) unreachable|failed 5\d\d\b/i.test(message);
}

/** Telnyx refuses the dial itself for a number that does not exist (error 10010, D50: no valid LRN); no webhook follows. */
export function isInvalidNumberError(message: string): boolean {
  return /destination number is invalid/i.test(message);
}

@Processor(CALL_QUEUE, { autorun: false })
export class CallWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CallWorker.name);
  private readonly limits = new Map<string, { value: number; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<QueueEnv, true>,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly providers: CallingProviders,
    private readonly activity: ActivityService,
    private readonly slots: CallSlots,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('CALL_WORKER_ENABLED', { infer: true })) {
      this.logger.log('Call worker is off on this instance (CALL_WORKER_ENABLED=false)');
      return;
    }
    this.worker.concurrency = this.config.get('CALL_WORKER_CONCURRENCY', { infer: true });
    void this.worker.run().catch((error) => this.logger.error(`Call worker stopped: ${(error as Error).message}`));
    this.logger.log(`Call worker started (concurrency ${this.worker.concurrency})`);
  }

  async process(job: Job<CallJobData>, token?: string): Promise<void> {
    if (job.name !== CallJob.Dial) throw new UnrecoverableError(`Unknown call job "${job.name}"`);
    const { orgId, leadId, sequenceId, callbackAt } = job.data;
    const callback = job.data.source === 'callback';
    const intent: CallIntent = {
      ...(job.data.voicemail && job.data.voicemail !== 'default' ? { voicemail: job.data.voicemail } : {}),
      ...(job.data.context ? { context: job.data.context } : {}),
    };

    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { phone: true, status: true, dncStatus: true, automationPaused: true, callbackAt: true },
    });
    if (!lead || lead.dncStatus || lead.automationPaused || (callback ? CALLBACK_BLOCKED : OUTCOME_STATUSES).includes(lead.status)) {
      this.logger.log(`Call for lead ${leadId} dropped: the lead can no longer be called`);
      return;
    }
    if (callback && lead.callbackAt?.toISOString() !== callbackAt) {
      this.logger.log(`Callback for lead ${leadId} at ${callbackAt} dropped: it was moved or cleared since`);
      return;
    }
    // Queued by a strategy or sequence the lead has since left (it ended, was stopped or swapped).
    if (!(await this.stillEnrolled(job.data, lead.status))) {
      this.logger.log(`Call for lead ${leadId} dropped: the lead has left the ${job.data.source ?? 'journey'} that queued it`);
      return;
    }
    if (await hasUpcomingMeeting(this.prisma, orgId, leadId)) {
      this.logger.log(`Call for lead ${leadId} dropped: a meeting with the lead is on the calendar`);
      return;
    }
    const { timeZone, quiet, skipDays, limits } = await this.followup.guardrailsFor(orgId);
    if (callback) {
      const live = await this.prisma.call.count({
        where: { leadId, status: { in: [CallStatus.ringing, CallStatus.in_progress] }, createdAt: { gte: new Date(Date.now() - LIVE_CALL_MAX_AGE_MS) } },
      });
      if (live > 0) return this.delay(job, Date.now() + LIVE_CALL_WAIT_MS, token);
    } else if (limits.redialGapMinutes > 0) {
      // The organization's wait after a decline or a busy line.
      const gapMs = limits.redialGapMinutes * 60_000;
      const last = await this.prisma.call.findFirst({ where: { leadId }, orderBy: { createdAt: 'desc' }, select: { disposition: true, endedAt: true } });
      const declined = last?.disposition === CallDisposition.busy || last?.disposition === CallDisposition.rejected;
      if (declined && last.endedAt && last.endedAt.getTime() + gapMs > Date.now()) {
        this.logger.log(`Call for lead ${leadId} waits: they declined or were busy at ${last.endedAt.toISOString()}`);
        return this.delay(job, last.endedAt.getTime() + gapMs, token);
      }
    }

    // A callback the lead asked for keeps to quiet hours only; everything else also skips the organization's days off.
    const allowed = callback ? nextAllowedAt(timeZone, quiet, new Date()) : nextContactAt(timeZone, quiet, skipDays, new Date());
    if (allowed.getTime() > Date.now()) return this.delay(job, allowed.getTime(), token);

    const slotId = String(job.id);
    if (!(await this.slots.acquire(orgId, slotId, await this.limitFor(orgId)))) {
      return this.delay(job, Date.now() + SLOT_WAIT_MS + Math.floor(Math.random() * SLOT_WAIT_JITTER_MS), token);
    }

    // Resolved at dial time, so a job queued before a provider switch dials through the new provider.
    let provider: CallingProvider | undefined;
    let call: { providerCallId?: string };
    try {
      provider = await this.providers.for(orgId);
      call = await provider.startCall(orgId, lead.phone ?? '', { leadId, orgId, ...(sequenceId ? { sequenceId } : {}), ...intent });
    } catch (error) {
      await this.slots.release(orgId, slotId);
      const message = (error as Error).message;
      if (isCapacityError(message)) {
        this.logger.warn(`${provider?.name === 'retell' ? 'Retell' : 'Telnyx'} is at capacity for org ${orgId}; call for lead ${leadId} waits: ${message}`);
        return this.delay(job, Date.now() + SLOT_WAIT_MS * 6, token);
      }
      if (isTransientDialError(message) && !job.data.dialRetried) {
        this.logger.warn(`Dial for lead ${leadId} failed on the provider's side; one retry in ${DIAL_RETRY_MS / 60_000} min: ${message}`);
        await job.updateData({ ...job.data, dialRetried: true });
        return this.delay(job, Date.now() + DIAL_RETRY_MS, token);
      }
      const invalid = isInvalidNumberError(message);
      await this.activity.recordCallFailed(orgId, leadId, message, invalid ? CallDisposition.invalid_number : CallDisposition.failed, provider?.name);
      if (invalid) await this.activity.markInvalid(leadId, 'Invalid number (Telnyx D50: the number does not exist)');
      return;
    }

    if (call.providerCallId) await this.slots.rename(orgId, slotId, call.providerCallId);
    else await this.slots.release(orgId, slotId);
    await this.activity.startCall(orgId, leadId, call.providerCallId, intent, provider.name);
  }

  /** A strategy call needs the lead still in the strategy; a sequence call, its enrolment still active. A callback has its own check. */
  private async stillEnrolled(data: CallJobData, status: LeadStatus): Promise<boolean> {
    if (data.source === 'strategy') return IN_STRATEGY_STATUSES.includes(status);
    if (data.source !== 'followup' || !data.sequenceId) return true;
    const enrolment = await this.prisma.sequenceEnrollment.findFirst({
      where: { leadId: data.leadId, sequenceId: data.sequenceId, status: EnrollmentStatus.active },
      select: { id: true },
    });
    return enrolment !== null;
  }

  private async delay(job: Job<CallJobData>, until: number, token?: string): Promise<never> {
    await job.moveToDelayed(until, token);
    throw new DelayedError();
  }

  private async limitFor(orgId: string): Promise<number> {
    const cached = this.limits.get(orgId);
    if (cached && cached.until > Date.now()) return cached.value;
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { maxConcurrentCalls: true } });
    const value = settings?.maxConcurrentCalls ?? DEFAULT_CALL_LIMIT;
    this.limits.set(orgId, { value, until: Date.now() + LIMIT_CACHE_MS });
    return value;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<CallJobData> | undefined, error: Error): void {
    if (!job || error instanceof DelayedError) return;
    this.logger.error(`Call job ${job.id} for lead ${job.data.leadId} failed on attempt ${job.attemptsMade}: ${error.message}`);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Call worker error: ${error.message}`);
  }
}

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { CallingProviders, type CallingProvider } from '@/calling/calling-providers';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { QueueEnv } from '@/common/utils/interface';
import { nextAllowedAt } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { OUTCOME_STATUSES } from '@/lead/lead-status';
import { CALL_QUEUE, CallJob } from '@/queue/queue.constants';
import { ActivityService } from '../activity.service';
import { CallSlots } from './call-slots';
import { DEFAULT_CALL_LIMIT, type CallJobData } from './call.types';

const LIMIT_CACHE_MS = 30_000;
const SLOT_WAIT_MS = 5_000;
const SLOT_WAIT_JITTER_MS = 5_000;

export function isCapacityError(message: string): boolean {
  return /failed 429|channel limit|concurrent call|too many/i.test(message);
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
    const { orgId, leadId, sequenceId } = job.data;

    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { phone: true, status: true, dncStatus: true, automationPaused: true },
    });
    if (!lead || lead.dncStatus || lead.automationPaused || OUTCOME_STATUSES.includes(lead.status)) {
      this.logger.log(`Call for lead ${leadId} dropped: the lead can no longer be called`);
      return;
    }

    const { timeZone, quiet } = await this.followup.guardrailsFor(orgId);
    const allowed = nextAllowedAt(timeZone, quiet, new Date());
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
      call = await provider.startCall(orgId, lead.phone ?? '', { leadId, orgId, ...(sequenceId ? { sequenceId } : {}) });
    } catch (error) {
      await this.slots.release(orgId, slotId);
      const message = (error as Error).message;
      if (isCapacityError(message)) {
        this.logger.warn(`${provider?.name === 'retell' ? 'Retell' : 'Telnyx'} is at capacity for org ${orgId}; call for lead ${leadId} waits: ${message}`);
        return this.delay(job, Date.now() + SLOT_WAIT_MS * 6, token);
      }
      await this.activity.recordCallFailed(orgId, leadId, message, provider?.name);
      return;
    }

    if (call.providerCallId) await this.slots.rename(orgId, slotId, call.providerCallId);
    else await this.slots.release(orgId, slotId);
    await this.activity.startCall(orgId, leadId, call.providerCallId, provider.name);
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

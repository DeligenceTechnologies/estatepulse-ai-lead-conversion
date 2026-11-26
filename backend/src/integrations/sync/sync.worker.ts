import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { NangoEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { INTEGRATION_SYNC_QUEUE, IntegrationSyncJob } from '@/queue/queue.constants';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { ProviderClient } from '../adapters/provider-client';
import { EMPTY_STATS, type PushJobData, type SyncJobData, type SyncStats } from '../integrations.types';
import { NangoError, NangoService } from '../nango/nango.service';
import { ProvidersService } from '../providers/providers.service';
import { LeadImporterService, type TwoWayImport } from './lead-importer.service';
import { WriteBackService, type PushOutcome } from './write-back.service';

/** Stats are written back every this many pages, so a long run shows progress. */
const PROGRESS_EVERY_PAGES = 5;

/**
 * Runs one integration sync: pages through the provider with the adapter,
 * imports each record idempotently, and records the outcome.
 *
 * Failure handling:
 * - REAUTH (grant revoked/expired): the connection is parked as reauth_required
 *   and the run fails at once; retrying cannot help.
 * - RATE_LIMITED: the job is delayed by the provider's Retry-After (or a minute)
 *   without spending an attempt.
 * - UNAVAILABLE / anything else: BullMQ retries with exponential backoff
 *   (queue defaults: 5 attempts, from 1 minute). Re-running is safe: unchanged
 *   records are skipped by content hash.
 * - A setup problem (table deleted, mapping invalid): fails at once with the reason.
 */
@Processor(INTEGRATION_SYNC_QUEUE, { autorun: false })
export class IntegrationSyncWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationSyncWorker.name);
  /** Timer runs that found nothing new: not logged, so a short interval does not flood the log. */
  private readonly quietRuns = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    private readonly nango: NangoService,
    private readonly providers: ProvidersService,
    private readonly importer: LeadImporterService,
    private readonly events: EventsBus,
    private readonly config: ConfigService<NangoEnv, true>,
    private readonly writeBack: WriteBackService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('INTEGRATION_WORKER_ENABLED', { infer: true })) {
      this.logger.log('Integration sync worker is off on this instance (INTEGRATION_WORKER_ENABLED=false)');
      return;
    }
    this.worker.concurrency = this.config.get('INTEGRATION_WORKER_CONCURRENCY', { infer: true });
    void this.worker.run().catch((error) => this.logger.error(`Integration sync worker stopped: ${(error as Error).message}`));
    this.logger.log(`Integration sync worker started (concurrency ${this.worker.concurrency})`);
  }

  async process(job: Job<SyncJobData | PushJobData>, token?: string): Promise<SyncStats | PushOutcome> {
    if (job.name === IntegrationSyncJob.Push) return this.processPush(job as Job<PushJobData>, token);
    if (job.name !== IntegrationSyncJob.Sync) throw new UnrecoverableError(`Unknown integration job "${job.name}"`);
    return this.processSync(job as Job<SyncJobData>, token);
  }

  /** Two-way write-back of one record. Rate limits wait without spending an attempt; outages retry with backoff. */
  private async processPush(job: Job<PushJobData>, token?: string): Promise<PushOutcome> {
    if (!this.nango.configured) throw new UnrecoverableError('Nango is not configured on this server.');
    try {
      return await this.writeBack.push(job.data.recordId);
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'RATE_LIMITED' && token) {
        await job.moveToDelayed(Date.now() + (error.retryAfterSeconds ?? 60) * 1000, token);
        throw new DelayedError();
      }
      throw error;
    }
  }

  private async processSync(job: Job<SyncJobData>, token?: string): Promise<SyncStats> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: job.data.runId },
      include: { connection: true },
    });
    // Cancelled (disconnect) or already finished by an earlier delivery of this job: nothing to do.
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return EMPTY_STATS;
    const { connection } = run;
    const adapter = this.adapters.get(connection.provider);
    if (!adapter?.import) throw new UnrecoverableError(`No importer for provider "${connection.provider}"`);
    if (connection.status === 'disconnected' || connection.status === 'reauth_required') {
      throw new UnrecoverableError(connection.status === 'disconnected' ? 'The account was disconnected.' : 'Reconnect this account to sync.');
    }
    if (!this.nango.configured) throw new UnrecoverableError('Nango is not configured on this server.');

    await this.prisma.integrationSyncRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: run.startedAt ?? new Date(), attempts: { increment: 1 } },
    });

    const settings = (connection.settings ?? {}) as Record<string, unknown>;
    const ctx = {
      connectionId: connection.id,
      orgId: connection.orgId,
      settings,
      client: new ProviderClient(this.nango, connection.providerConfigKey, connection.nangoConnectionId),
      actorId: null,
    };
    const { name: providerName } = await this.providers.displayOf(connection.provider);
    const target = {
      orgId: connection.orgId,
      connectionId: connection.id,
      leadSourceId: connection.leadSourceId,
      sourceName: adapter.import.sourceName(settings),
      providerName,
      channel: adapter.capabilities.includes('contacts') ? ('crm' as const) : ('import' as const),
    };
    const max = this.config.get('INTEGRATION_SYNC_MAX_RECORDS', { infer: true });
    const twoWayFields = connection.writeBackEnabled && adapter.writeBack ? adapter.writeBack.fields(settings) : null;
    const toPush = new Set<string>();
    const stats: SyncStats = { ...EMPTY_STATS };

    try {
      let cursor: unknown = null;
      let pages = 0;
      do {
        const fetchedAt = new Date();
        const page = await adapter.import.fetchPage(ctx, cursor);
        const twoWay: TwoWayImport | null = twoWayFields ? { fields: twoWayFields, fetchedAt } : null;
        const known = await this.importer.knownHashes(connection.id, page.records);
        for (const record of page.records) {
          stats.fetched++;
          try {
            const { outcome, pushRecordId } = await this.importer.importRecord(target, record, known, twoWay);
            stats[outcome]++;
            if (pushRecordId) toPush.add(pushRecordId);
          } catch (error) {
            // One bad record never sinks the run; it is counted and the rest go on.
            stats.failed++;
            this.logger.warn(`Sync ${run.id}: record ${record.externalId} failed: ${safeMessage(error)}`);
          }
        }
        cursor = page.next;
        pages++;
        if (pages % PROGRESS_EVERY_PAGES === 0) await this.saveStats(run.id, stats);
        if (stats.fetched >= max && cursor) {
          stats.truncated = true;
          break;
        }
      } while (cursor);
    } catch (error) {
      await this.saveStats(run.id, stats);
      if (error instanceof NangoError) {
        if (error.kind === 'REAUTH') {
          await this.markConnection(connection.id, 'reauth_required', 'REAUTH_REQUIRED', `${providerName} access was revoked or has expired. Reconnect to continue.`);
          throw new UnrecoverableError(`${providerName} access was revoked or has expired.`);
        }
        if (error.kind === 'MISCONFIGURED') {
          await this.markConnection(connection.id, 'error', 'NANGO_MISCONFIGURED', 'This integration is not set up correctly in Nango.');
          throw new UnrecoverableError('The integration is not set up correctly in Nango.');
        }
        if (error.kind === 'RATE_LIMITED' && token) {
          // Wait out the provider's limit without spending a retry attempt.
          await job.moveToDelayed(Date.now() + (error.retryAfterSeconds ?? 60) * 1000, token);
          await this.prisma.integrationSyncRun.update({ where: { id: run.id }, data: { status: 'queued', errorMessage: `${providerName} rate limit reached; resuming shortly.` } });
          throw new DelayedError();
        }
        if (error.kind === 'REJECTED') throw new UnrecoverableError(`${providerName} refused a request (HTTP ${error.status}).`);
      }
      // A customer-fixable setup problem (AppError / HttpException): say it, do not retry.
      if (error instanceof HttpException) throw new UnrecoverableError(safeMessage(error));
      throw error;
    }

    const finishedAt = new Date();
    // A timer run that found nothing new leaves no row: at a short interval they would pile up by the thousand.
    const noop = run.trigger === 'schedule' && !stats.created && !stats.attached && !stats.failed && !toPush.size;
    if (noop) {
      this.quietRuns.add(run.id);
      if (this.quietRuns.size > 1_000) this.quietRuns.clear();
    }
    await this.prisma.$transaction([
      noop
        ? this.prisma.integrationSyncRun.delete({ where: { id: run.id } })
        : this.prisma.integrationSyncRun.update({
            where: { id: run.id },
            data: { status: 'succeeded', finishedAt, stats: stats as unknown as Prisma.InputJsonValue, errorMessage: null },
          }),
      this.prisma.integrationConnection.update({
        where: { id: connection.id },
        data: {
          lastSyncedAt: finishedAt,
          // A successful sync proves the account works again.
          ...(connection.status === 'error' ? { status: 'connected', lastErrorCode: null, lastErrorMessage: null, lastErrorAt: null } : {}),
        },
      }),
    ]);
    if (stats.created || stats.attached) {
      this.events.publish({ organizationId: connection.orgId, type: 'lead.created', leadSourceId: connection.leadSourceId });
    }
    // EstatePulse won a conflict during this run: write its values back now rather than at the next sweep.
    for (const recordId of toPush) {
      await this.writeBack.queuePush(recordId).catch((error) => this.logger.warn(`Could not queue write-back of ${recordId}: ${safeMessage(error)}`));
    }
    return stats;
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SyncJobData | PushJobData>, result: SyncStats | PushOutcome): void {
    if (job.name !== IntegrationSyncJob.Sync || typeof result !== 'object') return;
    const stats = result;
    const data = job.data as SyncJobData;
    // Quiet when nothing happened, so a short automatic interval does not flood the log.
    if (this.quietRuns.delete(data.runId)) return;
    this.logger.log(
      `Sync run ${data.runId} done: ${stats.fetched} read, ${stats.created} new, ${stats.attached} attached, ${stats.unchanged} unchanged, ${stats.skipped} skipped, ${stats.failed} failed`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(anyJob: Job<SyncJobData | PushJobData> | undefined, error: Error): Promise<void> {
    if (!anyJob || error instanceof DelayedError || error.name === 'DelayedError') return;
    const final = error instanceof UnrecoverableError || error.name === 'UnrecoverableError' || anyJob.attemptsMade >= (anyJob.opts.attempts ?? 1);
    const message = safeMessage(error);
    if (anyJob.name === IntegrationSyncJob.Push) {
      const { recordId } = anyJob.data as PushJobData;
      if (final) {
        await this.writeBack.exhausted(recordId, message);
        this.logger.error(`Write-back of record ${recordId} failed: ${message}`);
      } else this.logger.warn(`Write-back of record ${recordId} attempt ${anyJob.attemptsMade} failed: ${message}; will retry`);
      return;
    }
    const job = anyJob as Job<SyncJobData>;
    try {
      await this.prisma.integrationSyncRun.updateMany({
        where: { id: job.data.runId, status: { in: ['queued', 'running'] } },
        data: final
          ? { status: 'failed', finishedAt: new Date(), errorMessage: message }
          : { status: 'queued', errorMessage: `Attempt ${job.attemptsMade} failed: ${message}. Retrying.`.slice(0, 500) },
      });
    } catch (dbError) {
      this.logger.error(`Could not record the failure of sync run ${job.data.runId}: ${(dbError as Error).message}`);
    }
    if (final) this.logger.error(`Sync run ${job.data.runId} failed: ${message}`);
    else this.logger.warn(`Sync run ${job.data.runId} attempt ${job.attemptsMade} failed: ${message}; will retry`);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Integration sync worker error: ${error.message}`);
  }

  private async saveStats(runId: string, stats: SyncStats): Promise<void> {
    await this.prisma.integrationSyncRun.update({ where: { id: runId }, data: { stats: stats as unknown as Prisma.InputJsonValue } });
  }

  private async markConnection(id: string, status: 'reauth_required' | 'error', code: string, message: string): Promise<void> {
    await this.prisma.integrationConnection.update({
      where: { id },
      data: { status, lastErrorCode: code, lastErrorMessage: message.slice(0, 500), lastErrorAt: new Date() },
    });
  }
}

/** An error's message for our logs and the run row: capped, and never a provider response body. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type IntegrationSyncRun, type IntegrationSyncTrigger } from '@prisma/client';
import type { Queue } from 'bullmq';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { INTEGRATION_SYNC_QUEUE, IntegrationSyncJob } from '@/queue/queue.constants';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { EMPTY_STATS, type SyncJobData, type SyncRunView, type SyncStats } from '../integrations.types';

const ENQUEUE_TIMEOUT_MS = 5_000;
/** A run still "running" this long after it started has lost its worker; it no longer blocks a new one. */
const STUCK_AFTER_MS = 2 * 60 * 60_000;

export function runView(run: IntegrationSyncRun): SyncRunView {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    stats: { ...EMPTY_STATS, ...((run.stats ?? {}) as Partial<SyncStats>) },
    attempts: run.attempts,
    errorMessage: run.errorMessage,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Queues syncs. A sync never runs inside an HTTP request: this writes a run row
 * and puts its id on the integration-sync queue; IntegrationSyncWorker does the
 * work with retries and backoff.
 *
 * Duplicates are prevented in the database: the partial unique index
 * integration_sync_runs_one_active allows one queued/running run per
 * connection, so a second request (double click, webhook, retry) gets the run
 * already in progress. The job id is the run id, and the worker skips a run
 * that is no longer queued or running, so a stray job never imports twice.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    private readonly audit: AuditService,
    @InjectQueue(INTEGRATION_SYNC_QUEUE) private readonly queue: Queue<SyncJobData>,
  ) {}

  /** Why this connection cannot sync, or null when it can. */
  blocker(connection: { provider: string; status: string; settings: unknown }): string | null {
    const adapter = this.adapters.get(connection.provider);
    if (!adapter?.import) return 'This integration does not import leads.';
    if (connection.status === 'disconnected') return 'This account was disconnected.';
    if (connection.status === 'reauth_required') return 'Reconnect this account before syncing.';
    const setup = adapter.setup?.state((connection.settings ?? {}) as Record<string, unknown>);
    if (setup && !setup.complete) return setup.missing ?? 'Finish this account’s setup before syncing.';
    return null;
  }

  /**
   * Queues a sync of one connection of `orgId`, or returns the one already queued
   * or running. `created` says which.
   */
  async enqueue(
    orgId: string,
    connectionId: string,
    trigger: IntegrationSyncTrigger,
    requestedById: string | null,
  ): Promise<{ run: SyncRunView; created: boolean }> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, orgId },
      select: { id: true, orgId: true, provider: true, status: true, settings: true },
    });
    if (!connection) throw new NotFoundException('That connection was not found.');
    const blocked = this.blocker(connection);
    if (blocked) throw new ConflictException(blocked);

    await this.releaseStuck(connectionId);

    let run: IntegrationSyncRun;
    try {
      run = await this.prisma.integrationSyncRun.create({
        data: { orgId, connectionId, trigger, requestedById, stats: EMPTY_STATS as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const active = await this.prisma.integrationSyncRun.findFirst({
          where: { connectionId, status: { in: ['queued', 'running'] } },
          orderBy: { queuedAt: 'desc' },
        });
        if (active) return { run: runView(active), created: false };
      }
      throw error;
    }

    try {
      const job = await this.withTimeout(
        this.queue.add(
          IntegrationSyncJob.Sync,
          { runId: run.id },
          // One job per run id: queueing the same run twice is a no-op in BullMQ.
          { jobId: `integration-sync-${run.id}` },
        ),
      );
      run = await this.prisma.integrationSyncRun.update({ where: { id: run.id }, data: { jobId: job.id ?? null } });
    } catch (error) {
      await this.prisma.integrationSyncRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), errorMessage: 'The sync queue is unavailable. Try again shortly.' },
      });
      this.logger.error(`Could not queue sync ${run.id}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The sync queue is unavailable. Try again shortly.');
    }

    // The timer can run every few seconds: its syncs are not audit events.
    if (trigger !== 'schedule') this.audit.quietly({
      orgId,
      actorType: requestedById ? 'user' : 'system',
      actorId: requestedById,
      action: 'integration.sync_queued',
      entityType: 'integration_connection',
      entityId: connectionId,
      payload: { runId: run.id, trigger },
    });
    return { run: runView(run), created: true };
  }

  async runs(orgId: string, connectionId: string, limit = 20): Promise<SyncRunView[]> {
    const owned = await this.prisma.integrationConnection.count({ where: { id: connectionId, orgId } });
    if (!owned) throw new NotFoundException('That connection was not found.');
    const rows = await this.prisma.integrationSyncRun.findMany({
      where: { connectionId, orgId },
      orderBy: { queuedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map(runView);
  }

  /** Fails queued runs of a connection that is going away, so they free the slot and say why. */
  async cancelActive(connectionId: string, reason: string): Promise<void> {
    await this.prisma.integrationSyncRun.updateMany({
      where: { connectionId, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), errorMessage: reason.slice(0, 500) },
    });
  }

  private async releaseStuck(connectionId: string): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const released = await this.prisma.integrationSyncRun.updateMany({
      where: {
        connectionId,
        OR: [
          { status: 'running', startedAt: { lt: cutoff } },
          { status: 'queued', queuedAt: { lt: cutoff } },
        ],
      },
      data: { status: 'failed', finishedAt: new Date(), errorMessage: 'The sync stopped responding and was abandoned.' },
    });
    if (released.count) this.logger.warn(`Released ${released.count} stuck sync run(s) of connection ${connectionId}`);
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('queue timeout')), ENQUEUE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

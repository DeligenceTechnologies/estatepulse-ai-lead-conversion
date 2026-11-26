import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { NangoEnv } from '@/common/utils/interface';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { NangoService } from '../nango/nango.service';
import { SyncService } from './sync.service';

/** A sync that failed is not retried by the timer sooner than this, so a broken setup is not hammered. */
const AFTER_FAILURE_MS = 5 * 60_000;
/** Accounts queued per tick at most; the next tick takes the rest. */
const PER_TICK = 200;

/**
 * Automatic provider -> EstatePulse sync. Every INTEGRATION_SYNC_INTERVAL_SECONDS
 * (0 = off), each connected, set-up account whose last sync finished at least
 * that long ago is queued. It only queues; the worker does the work.
 *
 * Safe at any interval and on several instances:
 * - an account with a sync already queued or running is skipped (and the
 *   database allows one active run per account anyway);
 * - a failed account waits at least 5 minutes before the timer tries again;
 * - a tick never overlaps the previous one.
 */
@Injectable()
export class SyncScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    private readonly nango: NangoService,
    private readonly sync: SyncService,
    private readonly config: ConfigService<NangoEnv, true>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('INTEGRATION_SYNC_INTERVAL_SECONDS', { infer: true }) ?? 0;
    if (!seconds) {
      this.logger.log('Automatic integration sync is off (INTEGRATION_SYNC_INTERVAL_SECONDS=0)');
      return;
    }
    if (!this.config.get('INTEGRATION_WORKER_ENABLED', { infer: true })) return;
    if (!this.nango.configured) {
      this.logger.warn('Automatic integration sync is off: Nango is not configured');
      return;
    }
    this.timer = setInterval(() => void this.tick(seconds * 1000), seconds * 1000);
    this.timer.unref();
    this.logger.log(`Automatic integration sync every ${seconds}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(intervalMs: number): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let queued = 0;
    try {
      const importing = this.adapters.all().filter((a) => a.import).map((a) => a.provider);
      if (!importing.length) return 0;
      const rows = await this.prisma.integrationConnection.findMany({
        where: {
          status: 'connected',
          provider: { in: importing },
          syncRuns: { none: { status: { in: ['queued', 'running'] } } },
        },
        select: {
          id: true,
          orgId: true,
          provider: true,
          status: true,
          settings: true,
          lastSyncedAt: true,
          syncRuns: { orderBy: { queuedAt: 'desc' }, take: 1, select: { status: true, queuedAt: true, finishedAt: true } },
        },
        orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
        take: PER_TICK,
      });
      const now = Date.now();
      for (const row of rows) {
        const last = row.syncRuns[0];
        // Timer runs that found nothing leave no row, so the last success is read from the account itself.
        const lastRunEnd = last ? (last.finishedAt ?? last.queuedAt).getTime() : 0;
        const endedAt = Math.max(lastRunEnd, row.lastSyncedAt?.getTime() ?? 0);
        const wait = last?.status === 'failed' && lastRunEnd >= endedAt ? Math.max(intervalMs, AFTER_FAILURE_MS) : intervalMs;
        if (endedAt && now - endedAt < wait) continue;
        if (this.sync.blocker(row)) continue;
        try {
          const { created } = await this.sync.enqueue(row.orgId, row.id, 'schedule', null);
          if (created) queued++;
        } catch (error) {
          this.logger.warn(`Could not queue the automatic sync of ${row.id}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Automatic integration sync tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
    return queued;
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CalendarSyncService } from './calendar-sync.service';
import type { CalendarConnectionMetadata } from './types';

/** An abandoned OAuth attempt is swept after this long. */
const PENDING_TTL_MS = 60 * 60 * 1000;

/**
 * Sweeps every connected OFFICE calendar on a timer, whichever provider it is.
 *
 * One row per organization since 20260922000002, so this loop is now over
 * tenants rather than over people — a fiftieth agent costs nothing.
 *
 * Polling rather than webhooks, on purpose: Calendly gates webhook
 * subscriptions behind a paid plan, so a poll is the only mechanism that works
 * for every customer. It is also the thing that must keep working once webhooks
 * are added, because webhook deliveries get dropped and a reconciler is the
 * difference between a missed appointment and a late one.
 *
 * Gated behind CALENDAR_SYNC=1 for the same reason LeadWatcher is gated behind
 * STRATEGY_ENGINE=1: this writes appointments and moves lead statuses, and must
 * never start doing that by accident against a shared development database.
 */
@Injectable()
export class CalendarPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CalendarPoller');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    // Unguarded by necessity: "which connections are due?" is a sweep across
    // every tenant by design. Everything the sync then does per connection is
    // scoped to that row's organization through the guarded client.
    private readonly unscoped: PrismaService,
    private readonly sync: CalendarSyncService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('CALENDAR_SYNC') !== '1') {
      this.logger.log('disabled (set CALENDAR_SYNC=1 to sync connected calendars)');
      return;
    }

    const intervalMs = Number(this.config.get<string>('CALENDAR_POLL_MS') ?? 300_000);
    this.logger.log(`syncing connected calendars every ${intervalMs}ms`);

    this.timer = setInterval(() => {
      void this.poll();
    }, intervalMs);
    // unref so a pending tick never holds the process open during shutdown.
    if (this.timer.unref) this.timer.unref();

    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Never throws. One broken connection must not stop the others, and the next
   * tick retries anyway. The overlap guard keeps a slow sweep from stacking.
   */
  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweepAbandonedAttempts();

      // `agent_id: null` is what makes this the office connections only. The
      // rows that still carry an agent_id are the retired per-agent
      // connections; 20260922000002 set them inactive, and the predicate is
      // here as well so a hand-reactivated row cannot quietly become a second
      // source of the same events.
      //
      // No `provider` predicate: an office runs on Calendly or on Cal.com, and
      // the sync dispatches on the row's own provider. Naming one here would
      // silently stop sweeping the other.
      const connections = await this.unscoped.calendar_connections.findMany({
        where: { status: 'active', agent_id: null },
      });

      for (const conn of connections) {
        try {
          const r = await this.sync.syncConnection(conn);
          if (r.created || r.updated || r.skippedNoLead || r.skippedNoAgent) {
            this.logger.log(
              `connection ${conn.id}: ${r.created} new, ${r.updated} updated, ` +
                `${r.skippedNoLead} skipped (no matching lead), ` +
                `${r.skippedNoAgent} skipped (host not on the roster) ` +
                `of ${r.scanned} scanned`,
            );
          }
        } catch (err) {
          // syncConnection has already recorded the reason on the row; this is
          // only so a failure is visible in the logs too.
          this.logger.warn(`connection ${conn.id} sync failed: ${String(err)}`);
        }
      }
    } catch (err) {
      this.logger.error(`calendar poll failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Delete OAuth attempts nobody finished.
   *
   * These are 'inactive' rows still carrying a stateHash. Left alone they are
   * harmless but they accumulate, and they make the "has this agent ever tried
   * to connect?" question harder to answer than it should be.
   */
  private async sweepAbandonedAttempts(): Promise<void> {
    const cutoff = Date.now() - PENDING_TTL_MS;
    // Calendly only. An OAuth attempt can be abandoned half-way — the browser
    // never comes back from the consent screen — and leaves a row behind.
    // Cal.com has no such state: a key is verified and stored in one request,
    // so there is nothing to sweep.
    const pending = await this.unscoped.calendar_connections.findMany({
      where: { provider: 'calendly', status: 'inactive', credentials_secret_ref: null },
      select: { id: true, metadata: true },
    });

    const stale = pending
      .filter((row) => {
        const meta = (row.metadata ?? {}) as CalendarConnectionMetadata;
        return Boolean(meta.stateHash) && Date.parse(meta.startedAt ?? '') < cutoff;
      })
      .map((row) => row.id);

    if (stale.length) {
      await this.unscoped.calendar_connections.deleteMany({ where: { id: { in: stale } } });
      this.logger.log(`swept ${stale.length} abandoned authorization attempt(s)`);
    }
  }
}

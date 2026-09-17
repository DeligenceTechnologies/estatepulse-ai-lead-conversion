import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { EngineService } from './engine.service';

/**
 * Auto-kickoff: polls for new leads and enrolls them into their org's strategy.
 *
 * A lead qualifies when status='new', not paused, not DNC, and never contacted
 * (first_contact_at IS NULL — enroll sets it, so a lead is picked up exactly
 * once even if ingestion enrolls it at the same moment).
 *
 * Only orgs that have connected their provider (a 'telnyx' integration row) are
 * processed. Gated behind STRATEGY_ENGINE=1 so it never starts calling real
 * people by accident against a shared development database.
 */
@Injectable()
export class LeadWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LeadWatcher');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    // Unguarded by necessity: the first query asks "which organizations have a
    // provider connected?", which is a sweep across every tenant by design.
    // The per-org query below is scoped and uses the guarded client.
    private readonly unscoped: PrismaService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly engine: EngineService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('STRATEGY_ENGINE') !== '1') {
      this.logger.log('disabled (set STRATEGY_ENGINE=1 to auto-enroll new leads)');
      return;
    }

    const intervalMs = Number(this.config.get<string>('ENGINE_POLL_MS') ?? 15000);
    this.logger.log(`watching for new leads every ${intervalMs}ms`);

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
   * Never throws: a poll that fails must not take the process down, and the
   * next tick retries anyway. The overlap guard keeps a slow poll from stacking.
   */
  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = await this.unscoped.integrations.findMany({
        where: { provider: 'telnyx', status: 'active' },
        select: { organization_id: true },
        distinct: ['organization_id'],
      });

      for (const { organization_id } of orgs) {
        const leads = await this.prisma.leads.findMany({
          where: {
            organization_id,
            status: 'new',
            automation_paused: false,
            dnc_status: false,
            first_contact_at: null,
          },
          select: { id: true },
          take: 10,
        });
        for (const lead of leads) {
          await this.engine.enroll(organization_id, lead.id);
        }
      }
    } catch (err) {
      this.logger.error(`poll error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

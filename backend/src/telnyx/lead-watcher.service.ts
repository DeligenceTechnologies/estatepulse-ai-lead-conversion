import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { EngineService } from './engine.service';
import { IN_STRATEGY_STATUSES } from '../common/domain';

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
  /** The first completed sweep also resumes strategies a restart interrupted. */
  private resumed = false;

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
   * Leads the engine claimed but never finished, because the process that owned
   * their timers went away.
   *
   * A restart drops every pending `setTimeout`, and the claim on
   * `first_contact_at` means the enrolment query above will never look at them
   * again. Without this sweep they sit at 'contacting' forever — no more steps,
   * no exit into nurture, and no way to add them to a sequence by hand, since
   * the enrolment guard reads the same "still in the strategy" signature.
   *
   * The age threshold is what makes this safe. A strategy runs in seconds to
   * hours, but a quiet-hours deferral can legitimately push its last step
   * overnight, so the default is a full day: long enough that nothing live is
   * ever cut short, short enough that a stranded lead is not forgotten.
   * EngineService.finalizeAbandoned additionally refuses any lead this process
   * is actively running.
   */
  private staleBefore(): Date {
    return new Date(Date.now() - Number(this.config.get<string>('STRATEGY_STALE_MS') ?? 86_400_000));
  }

  /**
   * Leads a previous process was mid-way through: claimed within the stale
   * window and still new|contacted. Their timers died with that process, so
   * the engine rebuilds the rest of the cadence from what is on record. Older
   * claims are left to recoverStranded, which ends them instead.
   */
  private async resumeInFlight(organizationId: string): Promise<void> {
    const inFlight = await this.prisma.leads.findMany({
      where: {
        organization_id: organizationId,
        status: { in: IN_STRATEGY_STATUSES },
        first_contact_at: { gte: this.staleBefore() },
        automation_paused: false,
        dnc_status: false,
      },
      select: { id: true },
      take: 200,
    });
    for (const lead of inFlight) {
      await this.engine.resume(organizationId, lead.id);
    }
  }

  private async recoverStranded(organizationId: string): Promise<void> {
    const before = this.staleBefore();

    const stranded = await this.prisma.leads.findMany({
      where: {
        organization_id: organizationId,
        status: { in: IN_STRATEGY_STATUSES },
        first_contact_at: { not: null, lt: before },
        automation_paused: false,
        dnc_status: false,
      },
      select: { id: true },
      take: 10,
    });

    for (const lead of stranded) {
      await this.engine.finalizeAbandoned(organizationId, lead.id);
    }
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
        // Before enrolling anything new, so a resumed lead is never mistaken
        // for one this process has not seen.
        if (!this.resumed) await this.resumeInFlight(organization_id);

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

        await this.recoverStranded(organization_id);
      }
      this.resumed = true;
    } catch (err) {
      this.logger.error(`poll error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

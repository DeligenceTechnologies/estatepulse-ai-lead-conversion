import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationStatus, LeadStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { IN_STRATEGY_STATUSES } from '@/lead/lead-status';
import { EngineService } from './engine.service';

const NEW_LEADS_PER_TICK = 10;

/**
 * Starts the outreach strategy for new leads of every organization with an
 * active Telnyx account, resumes in-flight leads after a restart, and parks
 * leads whose strategy stalled for longer than it could resume. Off unless
 * STRATEGY_ENGINE is set, because it calls and texts real people.
 */
@Injectable()
export class LeadWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LeadWatcher');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private resumed = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('STRATEGY_ENGINE', { infer: true })) {
      this.logger.log('disabled (set STRATEGY_ENGINE=true to contact new leads automatically)');
      return;
    }
    const intervalMs = this.config.get('ENGINE_POLL_MS', { infer: true });
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private staleBefore(): Date {
    return new Date(Date.now() - this.config.get('STRATEGY_STALE_MS', { infer: true }));
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = await this.prisma.integration.findMany({
        where: { provider: IntegrationProvider.telnyx, status: IntegrationStatus.active },
        select: { orgId: true },
        distinct: ['orgId'],
      });
      for (const { orgId } of orgs) {
        const workable = { orgId, automationPaused: false, dncStatus: false };
        if (!this.resumed) {
          const inFlight = await this.prisma.lead.findMany({
            where: { ...workable, status: { in: IN_STRATEGY_STATUSES }, firstContactAt: { gte: this.staleBefore() } },
            select: { id: true },
            take: 200,
          });
          for (const lead of inFlight) await this.engine.resume(orgId, lead.id);
        }
        const fresh = await this.prisma.lead.findMany({
          where: { ...workable, status: LeadStatus.new, firstContactAt: null },
          select: { id: true },
          take: NEW_LEADS_PER_TICK,
        });
        for (const lead of fresh) await this.engine.enroll(orgId, lead.id);
        const stranded = await this.prisma.lead.findMany({
          where: { ...workable, status: { in: IN_STRATEGY_STATUSES }, firstContactAt: { not: null, lt: this.staleBefore() } },
          select: { id: true },
          take: 10,
        });
        for (const lead of stranded) await this.engine.finalizeAbandoned(orgId, lead.id);
      }
      this.resumed = true;
    } catch (error) {
      this.logger.error(`poll error: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

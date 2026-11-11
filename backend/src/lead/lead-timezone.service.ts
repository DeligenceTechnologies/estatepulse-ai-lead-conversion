import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { jurisdictionCode, leadZone, type LeadZone } from '@/common/utils/lead-timezone';
import { CALL_QUEUE, TEXT_QUEUE } from '@/queue/queue.constants';
import { visibleLeads } from './lead-scope';
import { LeadStateService } from './lead-state.service';

/**
 * An agent's answer to "what time zone is this lead in". Stored on the lead, it
 * outranks the zone inferred from the phone number; null hands the decision
 * back to the number. Queued calls and texts waiting for this lead's window are
 * woken, so a worker measures them against the new zone at once; a strategy
 * step held in the engine's own timer picks it up at its next hourly look.
 */
@Injectable()
export class LeadTimezoneService {
  private readonly logger = new Logger(LeadTimezoneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    @InjectQueue(CALL_QUEUE) private readonly calls: Queue<{ leadId: string }>,
    @InjectQueue(TEXT_QUEUE) private readonly texts: Queue<{ leadId: string }>,
  ) {}

  /** Only the leads the user may see: a zone is calling hours, so an assigned-only agent sets it for their own leads alone. */
  async set(auth: AuthContext, leadId: string, timezone: string | null): Promise<LeadZone> {
    const { organizationId: orgId, userId } = auth;
    const updated = await this.prisma.lead.updateMany({ where: { id: leadId, ...visibleLeads(auth) }, data: { timezone } });
    if (updated.count === 0) throw new AppError('NOT_FOUND', 'No such lead');

    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { normalizedPhone: true } });
    const zone = leadZone({ timezone, normalizedPhone: lead?.normalizedPhone ?? null });
    const event = { orgId, leadId, source: 'agent', actor: { type: 'user' as const, id: userId } };
    this.state.quietly({
      ...event,
      type: 'timezone_set',
      reason: timezone ? `Time zone set to ${timezone} by an agent` : 'Time zone override removed; the phone number decides again',
      payload: { timezone, status: zone.status, jurisdiction: { ...zone.jurisdiction } },
    });
    if (zone.jurisdiction.status === 'conflict') {
      this.state.quietly({
        ...event,
        type: 'timezone_conflict',
        reason: `${timezone} is not a zone this phone number sits in (${zone.candidates.join(', ')}); the strictest calling hours apply`,
        payload: { timezone, candidates: zone.candidates },
      });
    }
    // Not a contact-gate decision: its own prefix, so "contact gate" stays one line per allowed/deferred/held call.
    this.logger.log(`timezone override org=${orgId} lead=${leadId} zone=${zone.zone ?? 'none'} status=${zone.status} jurisdiction=${jurisdictionCode(zone)} source=agent`);
    await this.wake(leadId);
    return zone;
  }

  /** Delayed calls and texts for the lead are promoted: the worker re-checks them against the new zone now. */
  private async wake(leadId: string): Promise<void> {
    // ponytail: scans every delayed job of both queues; index jobs by lead if the queues grow past a few thousand.
    for (const queue of [this.calls, this.texts]) {
      try {
        for (const job of await queue.getDelayed()) if (job.data.leadId === leadId) await job.promote();
      } catch (error) {
        this.logger.warn(`waking ${queue.name} jobs for lead ${leadId} failed: ${(error as Error).message}`);
      }
    }
  }
}

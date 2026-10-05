import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { AuthContext } from '../../auth/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Leads still being worked. Vocabulary is leads_status_check. */
const CLOSED_STATUSES = ['booked', 'closed', 'lost'];

/** Median of a non-empty list. Does not mutate the input. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The owner's office-wide numbers. Read-only, and every figure is a count over
 * real rows — there is nothing to show until leads arrive, and the screen says
 * so instead of inventing one.
 *
 * Owner-only on the class, so a route added later is protected by default. The
 * organization is the session's; nothing here takes an id from the caller.
 * Per-agent load is NOT here: GET /api/agents already returns activeLeads and
 * maxActiveLeads per member, and the dashboard reads it from there.
 */
@Controller('api/dashboard')
@UseGuards(SessionGuard, OwnerGuard)
export class OwnerDashboardController {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  @Get()
  async summary(@CurrentUser() auth: AuthContext) {
    const org = auth.organizationId;
    const now = Date.now();
    const since7 = new Date(now - 7 * DAY_MS);
    const since30 = new Date(now - 30 * DAY_MS);

    const [
      byStatusRows,
      byTempRows,
      last7Days,
      contactedRecent,
      hotUnassigned,
      neverContacted,
      needsReview,
      callRows,
      upcomingAppointments,
      sourceRows,
    ] = await Promise.all([
      this.prisma.leads.groupBy({ by: ['status'], where: { organization_id: org }, _count: { _all: true } }),
      this.prisma.leads.groupBy({
        by: ['temperature'],
        where: { organization_id: org, status: { notIn: CLOSED_STATUSES } },
        _count: { _all: true },
      }),
      this.prisma.leads.count({ where: { organization_id: org, created_at: { gte: since7 } } }),
      // ponytail: median computed in memory over ≤5000 recent leads; move to
      // percentile_cont in SQL if an office outgrows that in 30 days.
      this.prisma.leads.findMany({
        where: { organization_id: org, created_at: { gte: since30 }, first_contact_at: { not: null } },
        select: { created_at: true, first_contact_at: true },
        take: 5000,
      }),
      // Hot, still open, and nobody currently holds it.
      this.prisma.leads.count({
        where: {
          organization_id: org,
          temperature: 'hot',
          status: { notIn: CLOSED_STATUSES },
          lead_assignments: { none: { is_current: true } },
        },
      }),
      this.prisma.leads.count({
        where: { organization_id: org, status: 'new', first_contact_at: null, dnc_status: false },
      }),
      this.prisma.leads.count({ where: { organization_id: org, needs_review: true } }),
      this.prisma.voice_calls.groupBy({
        by: ['status'],
        where: { organization_id: org, created_at: { gte: since7 } },
        _count: { _all: true },
      }),
      this.prisma.appointments.count({
        where: {
          organization_id: org,
          start_at: { gte: new Date(now) },
          // Verbatim from appointments_status_check.
          status: { in: ['scheduled', 'rescheduled'] },
        },
      }),
      this.prisma.leads.groupBy({
        by: ['lead_source_id'],
        where: { organization_id: org, created_at: { gte: since30 } },
        _count: { _all: true },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of byStatusRows) byStatus[g.status] = g._count._all;

    const byTemperature = { hot: 0, warm: 0, cold: 0, unrated: 0 };
    for (const g of byTempRows) {
      const key = (g.temperature ?? 'unrated') as keyof typeof byTemperature;
      if (key in byTemperature) byTemperature[key] += g._count._all;
    }

    const delays = contactedRecent.map((l) => (l.first_contact_at!.getTime() - l.created_at.getTime()) / 1000);

    const calls: Record<string, number> = {};
    for (const g of callRows) calls[g.status] = g._count._all;

    const sourceIds = sourceRows.map((r) => r.lead_source_id).filter((id): id is string => id !== null);
    const sourceNames = new Map(
      (
        await this.prisma.lead_sources.findMany({
          where: { organization_id: org, id: { in: sourceIds } },
          select: { id: true, name: true },
        })
      ).map((s) => [s.id, s.name]),
    );
    const sources = sourceRows
      .map((r) => ({
        name: r.lead_source_id ? (sourceNames.get(r.lead_source_id) ?? 'Removed source') : 'No source',
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      leads: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        last7Days,
        byStatus,
        byTemperature,
      },
      // Lead created -> first outreach dispatched (leads.first_contact_at), last 30 days.
      speedToLead: {
        sample: delays.length,
        medianSeconds: delays.length ? Math.round(median(delays)) : null,
        within60sPct: delays.length ? Math.round((delays.filter((d) => d <= 60).length / delays.length) * 100) : null,
      },
      attention: { hotUnassigned, neverContacted, needsReview },
      calls7Days: { total: Object.values(calls).reduce((a, b) => a + b, 0), byStatus: calls },
      upcomingAppointments,
      sources30Days: sources,
    };
  }
}

import { Controller, Get } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { INACTIVE_STATUSES } from './lead-status';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_STATUSES = [LeadStatus.appointment_booked, ...INACTIVE_STATUSES];

interface SummaryRow {
  by_status: { status: string; n: number }[];
  temp_hot: number;
  temp_warm: number;
  temp_cold: number;
  temp_unrated: number;
  last7: number;
  hot_unassigned: number;
  never_contacted: number;
  needs_review: number;
  contacted_sample: number;
  contacted_within_60: number;
  median_delay_seconds: number | null;
  calls_by_status: Record<string, number> | null;
  upcoming_appointments: number;
  sources: { name: string | null; source_id: string | null; count: number }[] | null;
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  /** The owner's overview in one round trip. */
  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async summary(@CurrentAuth() auth: AuthContext) {
    const org = auth.organizationId;
    const now = Date.now();
    const since7 = new Date(now - 7 * DAY_MS);
    const since30 = new Date(now - 30 * DAY_MS);
    const closed = CLOSED_STATUSES as string[];

    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      WITH l AS (
        SELECT * FROM leads WHERE organization_id = ${org}::uuid
      ),
      -- Speed to lead: from arrival to the strategy's first step that really went (a text sent, a call
      -- queued), so a wait on the first step counts; leads from before the step log use first_contact_at.
      delays AS (
        SELECT extract(epoch FROM date_trunc('milliseconds', coalesce(
                 (SELECT min(e.created_at) FROM lead_events e
                   WHERE e.lead_id = l.id AND e.source = 'strategy' AND e.type = 'step_sent'),
                 first_contact_at))
               - date_trunc('milliseconds', created_at))::float8 AS s
          FROM l
         WHERE created_at >= ${since30} AND first_contact_at IS NOT NULL
      )
      SELECT
        (SELECT coalesce(json_agg(json_build_object('status', status, 'n', n)), '[]'::json)
           FROM (SELECT status, count(*)::int AS n FROM l GROUP BY status) s) AS by_status,
        count(*) FILTER (WHERE temperature = 'hot'  AND status <> ALL(${closed}::lead_status[]))::int AS temp_hot,
        count(*) FILTER (WHERE temperature = 'warm' AND status <> ALL(${closed}::lead_status[]))::int AS temp_warm,
        count(*) FILTER (WHERE temperature = 'cold' AND status <> ALL(${closed}::lead_status[]))::int AS temp_cold,
        count(*) FILTER (WHERE temperature IS NULL  AND status <> ALL(${closed}::lead_status[]))::int AS temp_unrated,
        count(*) FILTER (WHERE created_at >= ${since7})::int AS last7,
        count(*) FILTER (WHERE temperature = 'hot' AND status <> ALL(${closed}::lead_status[]) AND assigned_to_id IS NULL)::int AS hot_unassigned,
        count(*) FILTER (WHERE status = 'new' AND first_contact_at IS NULL AND NOT dnc_status)::int AS never_contacted,
        count(*) FILTER (WHERE needs_review)::int AS needs_review,
        (SELECT count(*)::int FROM delays) AS contacted_sample,
        (SELECT count(*)::int FROM delays WHERE s <= 60) AS contacted_within_60,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) FROM delays) AS median_delay_seconds,
        (SELECT json_object_agg(status, n)
           FROM (SELECT status, count(*)::int AS n FROM calls
                  WHERE organization_id = ${org}::uuid AND created_at >= ${since7}
                  GROUP BY status) c) AS calls_by_status,
        (SELECT count(*)::int FROM calendar_meetings
          WHERE organization_id = ${org}::uuid AND lead_id IS NOT NULL
            AND starts_at >= ${new Date(now)} AND status = 'scheduled') AS upcoming_appointments,
        (SELECT json_agg(json_build_object('source_id', g.lead_source_id, 'name', src.name, 'count', g.n)
                         ORDER BY g.n DESC, src.name)
           FROM (SELECT lead_source_id, count(*)::int AS n FROM l
                  WHERE created_at >= ${since30} GROUP BY lead_source_id) g
           LEFT JOIN lead_sources src
             ON src.id = g.lead_source_id AND src.organization_id = ${org}::uuid) AS sources
      FROM l`;

    const byStatus = Object.fromEntries(row.by_status.map((g) => [g.status, g.n]));
    const calls = row.calls_by_status ?? {};
    const sample = row.contacted_sample;
    return {
      leads: {
        total: row.by_status.reduce((sum, g) => sum + g.n, 0),
        last7Days: row.last7,
        byStatus,
        byTemperature: { hot: row.temp_hot, warm: row.temp_warm, cold: row.temp_cold, unrated: row.temp_unrated },
      },
      speedToLead: {
        sample,
        medianSeconds: sample ? Math.round(row.median_delay_seconds ?? 0) : null,
        within60sPct: sample ? Math.round((row.contacted_within_60 / sample) * 100) : null,
      },
      attention: {
        hotUnassigned: row.hot_unassigned,
        neverContacted: row.never_contacted,
        needsReview: row.needs_review,
      },
      calls7Days: { total: Object.values(calls).reduce((a, b) => a + b, 0), byStatus: calls },
      upcomingAppointments: row.upcoming_appointments,
      sources30Days: (row.sources ?? []).map((s) => ({
        name: s.source_id ? (s.name ?? 'Removed source') : 'No source',
        count: s.count,
      })),
    };
  }
}

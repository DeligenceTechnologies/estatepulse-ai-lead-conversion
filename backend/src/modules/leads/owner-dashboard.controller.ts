import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { AuthContext } from '../../auth/types';
import { INACTIVE_STATUSES, LEGACY_BOOKED, LeadStatus, normalizeStatusCounts } from '../../common/domain';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Leads no longer being worked: booked (an agent has it) or out of the pipeline. */
const CLOSED_STATUSES = [LeadStatus.APPOINTMENT_BOOKED, LEGACY_BOOKED, ...INACTIVE_STATUSES];

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

/**
 * The owner's office-wide numbers. Read-only, and every figure is a count over
 * real rows — there is nothing to show until leads arrive, and the screen says
 * so instead of inventing one.
 *
 * One SQL statement, one round trip. Each figure used to be its own Prisma
 * query; on a remote database every query is a network round trip, and eleven
 * of them through a small connection pool were most of this endpoint's latency.
 * Every subquery is scoped to the caller's organization, which comes from the
 * session — never from the request.
 *
 * Owner-only on the class, so a route added later is protected by default.
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
    const nowDate = new Date(now);

    // "Open" means not in CLOSED_STATUSES (lead status v2, legacy spellings
    // included) — the same rule the per-query version applied.
    const closed = CLOSED_STATUSES as string[];
    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      with l as (
        select * from leads where organization_id = ${org}::uuid
      ),
      delays as (
        -- Lead created -> first outreach, at the millisecond precision the
        -- previous JS computation saw through Date objects.
        select extract(epoch from date_trunc('milliseconds', first_contact_at)
                                - date_trunc('milliseconds', created_at))::float8 as s
          from l
         where created_at >= ${since30} and first_contact_at is not null
      )
      select
        (select coalesce(json_agg(json_build_object('status', status, 'n', n)), '[]'::json)
           from (select status, count(*)::int as n from l group by status) s) as by_status,
        count(*) filter (where temperature = 'hot'   and status <> all(${closed}::text[]))::int as temp_hot,
        count(*) filter (where temperature = 'warm'  and status <> all(${closed}::text[]))::int as temp_warm,
        count(*) filter (where temperature = 'cold'  and status <> all(${closed}::text[]))::int as temp_cold,
        count(*) filter (where temperature is null   and status <> all(${closed}::text[]))::int as temp_unrated,
        count(*) filter (where created_at >= ${since7})::int as last7,
        -- Hot, still open, and nobody currently holds it.
        count(*) filter (
          where temperature = 'hot' and status <> all(${closed}::text[])
            and not exists (select 1 from lead_assignments a
                             where a.lead_id = l.id and a.is_current
                               and a.organization_id = ${org}::uuid)
        )::int as hot_unassigned,
        count(*) filter (where status = 'new' and first_contact_at is null and dnc_status = false)::int as never_contacted,
        count(*) filter (where needs_review)::int as needs_review,
        (select count(*)::int from delays) as contacted_sample,
        (select count(*)::int from delays where s <= 60) as contacted_within_60,
        (select percentile_cont(0.5) within group (order by s) from delays) as median_delay_seconds,
        (select json_object_agg(status, n)
           from (select status, count(*)::int as n from voice_calls
                  where organization_id = ${org}::uuid and created_at >= ${since7}
                  group by status) c) as calls_by_status,
        (select count(*)::int from appointments
          where organization_id = ${org}::uuid and start_at >= ${nowDate}
            and status in ('scheduled','rescheduled')) as upcoming_appointments,
        (select json_agg(json_build_object('source_id', g.lead_source_id, 'name', src.name, 'count', g.n)
                         order by g.n desc, src.name)
           from (select lead_source_id, count(*)::int as n from l
                  where created_at >= ${since30} group by lead_source_id) g
           left join lead_sources src
             on src.id = g.lead_source_id and src.organization_id = ${org}::uuid) as sources
      from l
    `;

    const byStatus = normalizeStatusCounts(
      row.by_status.map((g) => ({ status: g.status, _count: { _all: g.n } })),
    );

    const calls = row.calls_by_status ?? {};
    const sample = row.contacted_sample;

    return {
      leads: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        last7Days: row.last7,
        byStatus,
        byTemperature: { hot: row.temp_hot, warm: row.temp_warm, cold: row.temp_cold, unrated: row.temp_unrated },
      },
      // Lead created -> first outreach dispatched (leads.first_contact_at), last 30 days.
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

import { Injectable } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { OUTSIDE_IMPORT_REVIEW, OUTSIDE_IMPORT_REVIEW_SQL, visibleLeads } from '@/lead/lead-scope';
import { LeadStateService } from '@/lead/lead-state.service';
import { CostLedgerService } from './cost-ledger.service';
import type { DealOutcome } from './dto/source-roi.dto';
import { buildRows, buildTotals, monthRange, monthStart, type RoiRow, type RoiTotals, type SourceCounts } from './roi-math';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReportRow {
  source_id: string | null;
  name: string | null;
  provider: string | null;
  archived: boolean;
  leads: number;
  contacted: number;
  qualified: number;
  booked: number;
  held: number;
  no_show: number;
  won: number;
  lost: number;
  revenue: number;
  comm_cost: number;
  spend: number;
}

export interface RoiReport {
  from: string;
  to: string;
  months: number;
  currency: 'USD';
  rows: RoiRow[];
  totals: RoiTotals;
  /** The earliest appointment on record: appointments before it were never kept. Null when there are none. */
  appointmentsTrackedSince: string | null;
}

export interface DealDTO {
  outcome: DealOutcome | null;
  value: number | null;
  closedAt: string | null;
}

/**
 * Source ROI: for the leads each lead source brought in, how many were
 * reached, qualified, booked and closed, and what that cost.
 *
 * The report is by cohort. A month means "the leads that ARRIVED that month",
 * and everything those leads did later (an appointment next month, a closing
 * next quarter, the calls and texts along the way) counts for that month. That
 * is what makes the month's spend comparable to its results, and keeps every
 * rate at or under 100%.
 */
@Injectable()
export class SourceRoiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CostLedgerService,
    private readonly state: LeadStateService,
  ) {}

  async report(orgId: string, from: string, to: string): Promise<RoiReport> {
    const range = monthRange(from, to);
    await this.ledger.topUp(orgId);

    const [rows, tracked] = await Promise.all([
      this.prisma.$queryRaw<ReportRow[]>`
        WITH tz AS (
          SELECT coalesce((SELECT timezone FROM org_settings WHERE organization_id = ${orgId}::uuid), 'America/New_York') AS z
        ),
        -- The cohort: leads that arrived in the months asked for, by the office's clock. The same
        -- leads every list shows: not ones still in (or rejected from) Import Review, not manual
        -- leads still waiting for their consent to be recorded.
        l AS (
          SELECT id, lead_source_id, first_response_at, temperature, deal_outcome, deal_value
            FROM leads
           WHERE organization_id = ${orgId}::uuid
             AND created_at >= (${range.start}::date::timestamp AT TIME ZONE (SELECT z FROM tz))
             AND created_at <  (${range.endExclusive}::date::timestamp AT TIME ZONE (SELECT z FROM tz))
             AND ${OUTSIDE_IMPORT_REVIEW_SQL}
        ),
        -- Per lead, not per meeting: a reschedule is two rows at the provider but one appointment.
        -- Booked = an appointment that stands: a lead whose only booking was cancelled did not book,
        -- and the row a reschedule leaves behind is replaced by a scheduled one.
        -- Held = it was due to happen (still scheduled, its time has passed) and nobody marked a no-show.
        appt AS (
          SELECT a.lead_id,
                 bool_or(a.status = 'scheduled') AS booked,
                 bool_or(a.status = 'scheduled' AND a.ends_at < now() AND a.no_show_at IS NULL) AS held,
                 bool_or(a.status = 'scheduled' AND a.no_show_at IS NOT NULL) AS no_show
            FROM lead_appointments a
           WHERE a.organization_id = ${orgId}::uuid AND a.lead_id IN (SELECT id FROM l)
           GROUP BY a.lead_id
        ),
        cost AS (
          SELECT u.lead_id, sum(u.amount) AS amount
            FROM usage_records u
           WHERE u.organization_id = ${orgId}::uuid AND u.lead_id IN (SELECT id FROM l)
           GROUP BY u.lead_id
        ),
        g AS (
          SELECT l.lead_source_id,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE l.first_response_at IS NOT NULL)::int AS contacted,
                 count(*) FILTER (WHERE l.temperature IN ('hot','warm'))::int AS qualified,
                 count(*) FILTER (WHERE appt.booked)::int AS booked,
                 count(*) FILTER (WHERE appt.held)::int AS held,
                 count(*) FILTER (WHERE appt.no_show AND NOT appt.held)::int AS no_show,
                 count(*) FILTER (WHERE l.deal_outcome = 'won')::int AS won,
                 count(*) FILTER (WHERE l.deal_outcome = 'lost')::int AS lost,
                 coalesce(sum(l.deal_value) FILTER (WHERE l.deal_outcome = 'won'), 0)::float8 AS revenue,
                 coalesce(sum(cost.amount), 0)::float8 AS comm_cost
            FROM l
            LEFT JOIN appt ON appt.lead_id = l.id
            LEFT JOIN cost ON cost.lead_id = l.id
           GROUP BY l.lead_source_id
        ),
        sp AS (
          SELECT lead_source_id, sum(amount)::float8 AS spend
            FROM lead_source_spend
           WHERE organization_id = ${orgId}::uuid
             AND month >= ${range.start}::date AND month < ${range.endExclusive}::date
           GROUP BY lead_source_id
        )
        -- Every source still in use shows, leads or not, so its spend can be entered; an archived
        -- one only while it has leads or spend in these months.
        SELECT src.id AS source_id, src.name, src.provider::text AS provider, (src.archived_at IS NOT NULL) AS archived,
               coalesce(g.leads, 0) AS leads, coalesce(g.contacted, 0) AS contacted, coalesce(g.qualified, 0) AS qualified,
               coalesce(g.booked, 0) AS booked, coalesce(g.held, 0) AS held, coalesce(g.no_show, 0) AS no_show,
               coalesce(g.won, 0) AS won, coalesce(g.lost, 0) AS lost,
               coalesce(g.revenue, 0)::float8 AS revenue, coalesce(g.comm_cost, 0)::float8 AS comm_cost,
               coalesce(sp.spend, 0)::float8 AS spend
          FROM lead_sources src
          LEFT JOIN g ON g.lead_source_id = src.id
          LEFT JOIN sp ON sp.lead_source_id = src.id
         WHERE src.organization_id = ${orgId}::uuid
           AND (src.archived_at IS NULL OR g.leads > 0 OR sp.spend > 0)
        UNION ALL
        SELECT NULL, NULL, NULL, false, g.leads, g.contacted, g.qualified, g.booked, g.held, g.no_show,
               g.won, g.lost, g.revenue, g.comm_cost, 0::float8
          FROM g
         WHERE g.lead_source_id IS NULL`,
      this.prisma.leadAppointment.aggregate({ where: { orgId }, _min: { bookedAt: true } }),
    ]);

    const table = buildRows(rows.map(toCounts));
    return {
      from,
      to,
      months: range.months,
      currency: 'USD',
      rows: table,
      totals: buildTotals(table),
      appointmentsTrackedSince: tracked._min.bookedAt?.toISOString() ?? null,
    };
  }

  /** Sets what was spent on a source in a month; null or 0 clears it. A source of another organization is NOT_FOUND. */
  async setSpend(auth: AuthContext, input: { leadSourceId: string; month: string; amount: number | null }) {
    const orgId = auth.organizationId;
    const month = new Date(`${monthStart(input.month)}T00:00:00.000Z`);
    const source = await this.prisma.leadSource.findFirst({
      where: { id: input.leadSourceId, orgId },
      select: { id: true, archivedAt: true },
    });
    if (!source) throw new AppError('NOT_FOUND', 'No such lead source');

    const key = { orgId, leadSourceId: source.id, month };
    if (!input.amount) {
      await this.prisma.leadSourceSpend.deleteMany({ where: key });
      return { leadSourceId: source.id, month: input.month, amount: 0 };
    }
    if (source.archivedAt) throw new AppError('CONFLICT', 'This lead source was removed; spend can no longer be added to it.');
    await this.prisma.leadSourceSpend.upsert({
      where: { orgId_leadSourceId_month: key },
      create: { ...key, amount: input.amount, updatedById: auth.userId },
      update: { amount: input.amount, updatedById: auth.userId },
    });
    return { leadSourceId: source.id, month: input.month, amount: input.amount };
  }

  async getDeal(auth: AuthContext, leadId: string): Promise<DealDTO> {
    return toDeal(await this.visibleLead(auth, leadId));
  }

  /**
   * Records how the deal ended. Won keeps a value; lost has none; null reopens
   * the deal. On a deal that stays won, a value or closing date left out keeps
   * what is saved (an explicit null clears the value). The lead's status is not touched: it says where outreach stands,
   * and a lead can be won while its status still reads "appointment booked".
   */
  async setDeal(
    auth: AuthContext,
    leadId: string,
    input: { outcome: DealOutcome | null; value?: number | null; closedAt?: string | null },
  ): Promise<DealDTO> {
    const lead = await this.visibleLead(auth, leadId);
    const savedValue = lead.dealOutcome === 'won' && lead.dealValue !== null ? Number(lead.dealValue) : null;
    const data = {
      dealOutcome: input.outcome,
      dealValue: input.outcome === 'won' ? (input.value === undefined ? savedValue : input.value) : null,
      dealClosedAt: input.outcome ? (input.closedAt ? new Date(input.closedAt) : (lead.dealClosedAt ?? new Date())) : null,
    };
    if (data.dealClosedAt && Number.isNaN(data.dealClosedAt.getTime())) {
      throw new AppError('VALIDATION_ERROR', 'The closing date is not a date.');
    }
    if (data.dealClosedAt && data.dealClosedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw new AppError('VALIDATION_ERROR', 'The closing date cannot be in the future.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({
        where: { id: lead.id },
        data,
        select: { dealOutcome: true, dealValue: true, dealClosedAt: true },
      });
      await this.state.record(
        {
          orgId: auth.organizationId,
          leadId: lead.id,
          type: input.outcome ? 'deal_outcome_set' : 'deal_outcome_cleared',
          source: 'agent',
          reason: input.outcome ? `Deal marked ${input.outcome}` : 'Deal reopened',
          actor: { type: 'user', id: auth.userId },
          payload: {
            outcome: input.outcome,
            value: data.dealValue,
            closedAt: data.dealClosedAt?.toISOString() ?? null,
            previous: { outcome: lead.dealOutcome, value: lead.dealValue === null ? null : Number(lead.dealValue) },
          },
        },
        tx,
      );
      return row;
    });
    return toDeal(updated);
  }

  private async visibleLead(auth: AuthContext, leadId: string) {
    const lead = UUID.test(leadId)
      ? await this.prisma.lead.findFirst({
          where: { id: leadId, ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW },
          select: { id: true, dealOutcome: true, dealValue: true, dealClosedAt: true },
        })
      : null;
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead');
    return lead;
  }
}

const toCounts = (row: ReportRow): SourceCounts => ({
  sourceId: row.source_id,
  name: row.name,
  provider: row.provider,
  archived: row.archived,
  leads: row.leads,
  contacted: row.contacted,
  qualified: row.qualified,
  booked: row.booked,
  held: row.held,
  noShow: row.no_show,
  won: row.won,
  lost: row.lost,
  revenue: row.revenue,
  spend: row.spend,
  commCost: row.comm_cost,
});

function toDeal(lead: { dealOutcome: string | null; dealValue: { toString(): string } | null; dealClosedAt: Date | null }): DealDTO {
  return {
    outcome: (lead.dealOutcome as DealOutcome | null) ?? null,
    value: lead.dealValue === null ? null : Number(lead.dealValue),
    closedAt: lead.dealClosedAt?.toISOString() ?? null,
  };
}

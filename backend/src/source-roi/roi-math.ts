import { AppError } from '@/common/errors/app-error';

/** A report may span at most this many months. */
export const MAX_MONTHS = 24;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** What one lead source's leads did, as counted by the report query. */
export interface SourceCounts {
  sourceId: string | null;
  name: string | null;
  provider: string | null;
  archived: boolean;
  leads: number;
  contacted: number;
  qualified: number;
  booked: number;
  held: number;
  noShow: number;
  won: number;
  lost: number;
  revenue: number;
  spend: number;
  commCost: number;
}

export interface RoiRow extends Omit<SourceCounts, 'name'> {
  name: string;
  /** False for the "Added manually" row: there is no source to spend on. */
  spendEditable: boolean;
  totalCost: number;
  contactRate: number | null;
  qualificationRate: number | null;
  costPerLead: number | null;
  costPerAppointment: number | null;
  costPerClosing: number | null;
}

export type RoiTotals = Omit<RoiRow, 'sourceId' | 'name' | 'provider' | 'archived' | 'spendEditable'>;

/** Leads with no source were typed in on the Leads screen, or texted in from an unknown number. */
export const MANUAL_ROW_NAME = 'Added manually';

/** n / d, or null when there is nothing to divide by: "no appointments yet" is not "free appointments". */
export const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

const cents = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number | null): number | null => (n === null ? null : cents(n));

function derive<T extends Omit<SourceCounts, 'sourceId' | 'name' | 'provider' | 'archived'>>(c: T) {
  const totalCost = cents(c.spend + c.commCost);
  return {
    totalCost,
    contactRate: ratio(c.contacted, c.leads),
    qualificationRate: ratio(c.qualified, c.leads),
    costPerLead: money(ratio(totalCost, c.leads)),
    costPerAppointment: money(ratio(totalCost, c.booked)),
    costPerClosing: money(ratio(totalCost, c.won)),
  };
}

/** The table's rows: busiest source first, the source-less row last. */
export function buildRows(counts: SourceCounts[]): RoiRow[] {
  return counts
    .map((c) => ({
      ...c,
      revenue: cents(c.revenue),
      spend: cents(c.spend),
      commCost: cents(c.commCost),
      name: c.sourceId ? (c.name ?? 'Removed source') : MANUAL_ROW_NAME,
      spendEditable: c.sourceId !== null && !c.archived,
    }))
    .map((c) => ({ ...c, ...derive(c) }))
    .sort(
      (a, b) =>
        Number(a.sourceId === null) - Number(b.sourceId === null) || b.leads - a.leads || a.name.localeCompare(b.name),
    );
}

const SUMMED = ['leads', 'contacted', 'qualified', 'booked', 'held', 'noShow', 'won', 'lost', 'revenue', 'spend', 'commCost'] as const;

/** The totals row: sums of the counts and money, with the rates worked out again from those sums. */
export function buildTotals(rows: RoiRow[]): RoiTotals {
  const sums = Object.fromEntries(SUMMED.map((key) => [key, 0])) as Record<(typeof SUMMED)[number], number>;
  for (const row of rows) for (const key of SUMMED) sums[key] += row[key];
  for (const key of ['revenue', 'spend', 'commCost'] as const) sums[key] = cents(sums[key]);
  return { ...sums, ...derive(sums) };
}

export interface MonthRange {
  /** First day of the first month, YYYY-MM-DD. */
  start: string;
  /** First day of the month after the last one, YYYY-MM-DD. */
  endExclusive: string;
  months: number;
}

/** First day of a YYYY-MM month as YYYY-MM-DD; rejects anything else. */
export function monthStart(month: string): string {
  if (!MONTH.test(month)) throw new AppError('VALIDATION_ERROR', 'A month must look like 2026-11.');
  return `${month}-01`;
}

/** The months `from`..`to`, both included. */
export function monthRange(from: string, to: string): MonthRange {
  const start = monthStart(from);
  monthStart(to);
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  if (months < 1) throw new AppError('VALIDATION_ERROR', 'The first month must not be after the last.');
  if (months > MAX_MONTHS) throw new AppError('VALIDATION_ERROR', `A report covers at most ${MAX_MONTHS} months.`);
  const next = tm === 12 ? `${ty + 1}-01` : `${ty}-${String(tm + 1).padStart(2, '0')}`;
  return { start, endExclusive: `${next}-01`, months };
}

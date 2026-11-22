import { ApiError, apiFetch } from '../lib/api';

/**
 * Source ROI: what each lead source costs per appointment and per closing.
 * These routes exist only where the server has SOURCE_ROI_ENABLED=1; elsewhere
 * every one answers 404, which is how the page and its controls know to hide.
 */

const BASE = '/v1/source-roi';

export interface RoiNumbers {
  leads: number;
  contacted: number;
  qualified: number;
  booked: number;
  held: number;
  noShow: number;
  won: number;
  lost: number;
  revenue: number;
  /** Marketing spend the owner entered for the months shown. */
  spend: number;
  /** Estimated cost of the AI calls and texts these leads took. */
  commCost: number;
  totalCost: number;
  contactRate: number | null;
  qualificationRate: number | null;
  costPerLead: number | null;
  costPerAppointment: number | null;
  costPerClosing: number | null;
}

export interface RoiRow extends RoiNumbers {
  /** Null for leads that came from no source (added by hand). */
  sourceId: string | null;
  name: string;
  provider: string | null;
  archived: boolean;
  spendEditable: boolean;
}

export interface RoiReport {
  from: string;
  to: string;
  months: number;
  currency: 'USD';
  rows: RoiRow[];
  totals: RoiNumbers;
  appointmentsTrackedSince: string | null;
}

export interface CostRates {
  callRatePerMinute: number;
  smsRatePerSegment: number;
}

export interface RatesSettings extends CostRates {
  custom: { callRatePerMinute: boolean; smsRatePerSegment: boolean };
  defaults: CostRates;
}

export type DealOutcome = 'won' | 'lost';

export interface Deal {
  outcome: DealOutcome | null;
  value: number | null;
  closedAt: string | null;
}

export const isSourceRoiDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

let probe: Promise<boolean> | null = null;

/**
 * Whether the server has Source ROI switched on. Asked once per page load and
 * shared: several screens (the nav, a lead, each appointment card) need it. A
 * failure other than "not found" is not cached, so a blip does not hide the
 * feature until the next reload.
 */
export function sourceRoiEnabled(): Promise<boolean> {
  probe ??= apiFetch<{ enabled: boolean }>(`${BASE}/config`, { auth: true }).then(
    () => true,
    (e) => {
      if (!isSourceRoiDisabled(e)) probe = null;
      return false;
    },
  );
  return probe;
}

/** For tests: forget the cached answer. */
export const resetSourceRoiProbe = (): void => {
  probe = null;
};

export const getRoiReport = (from: string, to: string): Promise<RoiReport> =>
  apiFetch<RoiReport>(`${BASE}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { auth: true });

export const putSpend = (body: { leadSourceId: string; month: string; amount: number | null }): Promise<{ amount: number }> =>
  apiFetch<{ amount: number }>(`${BASE}/spend`, { method: 'PUT', body, auth: true });

export const getRates = (): Promise<RatesSettings> => apiFetch<RatesSettings>(`${BASE}/rates`, { auth: true });

/** Null puts a rate back on the default. */
export const putRates = (body: { callRatePerMinute?: number | null; smsRatePerSegment?: number | null }): Promise<RatesSettings> =>
  apiFetch<RatesSettings>(`${BASE}/rates`, { method: 'PUT', body, auth: true });

export const getDeal = (leadId: string): Promise<Deal> => apiFetch<Deal>(`/v1/leads/${leadId}/deal`, { auth: true });

/** `outcome: null` reopens the deal. */
export const putDeal = (leadId: string, body: { outcome: DealOutcome | null; value?: number | null; closedAt?: string | null }): Promise<Deal> =>
  apiFetch<Deal>(`/v1/leads/${leadId}/deal`, { method: 'PUT', body, auth: true });

export const putNoShow = (meetingId: string, noShow: boolean): Promise<{ meetingId: string; noShowAt: string | null }> =>
  apiFetch<{ meetingId: string; noShowAt: string | null }>(`${BASE}/appointments/${meetingId}/no-show`, {
    method: 'PUT',
    body: { noShow },
    auth: true,
  });

import { apiFetch } from '../lib/api';

/** The owner's office-wide numbers. Organization is the session's; no params. */
export interface OwnerDashboard {
  leads: {
    total: number;
    last7Days: number;
    /** new | contacted | qualified | nurture | booked | closed | lost */
    byStatus: Record<string, number>;
    /** Open leads only (not booked, closed or lost). */
    byTemperature: { hot: number; warm: number; cold: number; unrated: number };
  };
  /** Lead created -> first outreach, last 30 days. Nulls when nothing was contacted. */
  speedToLead: { sample: number; medianSeconds: number | null; within60sPct: number | null };
  attention: { hotUnassigned: number; neverContacted: number; needsReview: number };
  calls7Days: { total: number; byStatus: Record<string, number> };
  upcomingAppointments: number;
  sources30Days: { name: string; count: number }[];
}

export const getOwnerDashboard = (): Promise<OwnerDashboard> =>
  apiFetch<OwnerDashboard>('/dashboard', { auth: true });

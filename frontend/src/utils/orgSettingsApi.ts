import { apiFetch } from '../lib/api';
import type { WorkingDay } from './workingHours';

/**
 * The organization's settings (the backend's `org_settings` table, one row per
 * organization). Always the caller's own organization: the server reads it
 * from the session. Read needs organization.read, saving organization.update.
 */
export interface OrgSettings {
  id: string;
  /** IANA zone the business hours are read in (server default Asia/Kolkata). */
  timezone: string;
  /** Seven days (server default Mon-Fri 09:00-18:00, weekend off). */
  workingHours: WorkingDay[];
  /** Of the concurrent call limit, kept free by outreach batches for new form leads and follow-ups (server default 1). */
  reservedCallSlots: number;
  updatedAt: string;
}

export type OrgSettingsUpdate = Partial<Pick<OrgSettings, 'timezone' | 'workingHours' | 'reservedCallSlots'>>;

export const getOrgSettings = (): Promise<OrgSettings> => apiFetch<OrgSettings>('/org-settings', { auth: true });

/** Only the keys sent are changed. */
export const updateOrgSettings = (input: OrgSettingsUpdate): Promise<OrgSettings> =>
  apiFetch<OrgSettings>('/org-settings', { method: 'PATCH', body: input, auth: true });

/** Owner only: adds or removes the Agent role on the signed-in owner, so leads can be assigned to them. */
export const setLeadAssignment = (assignToMe: boolean): Promise<{ assignToMe: boolean }> =>
  apiFetch<{ assignToMe: boolean }>('/org-settings/lead-assignment', { method: 'PUT', body: { assignToMe }, auth: true });

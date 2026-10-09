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
  updatedAt: string;
}

export type OrgSettingsUpdate = Partial<Pick<OrgSettings, 'timezone' | 'workingHours'>>;

export const getOrgSettings = (): Promise<OrgSettings> => apiFetch<OrgSettings>('/org-settings', { auth: true });

/** Only the keys sent are changed. */
export const updateOrgSettings = (input: OrgSettingsUpdate): Promise<OrgSettings> =>
  apiFetch<OrgSettings>('/org-settings', { method: 'PATCH', body: input, auth: true });

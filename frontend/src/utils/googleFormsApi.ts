import { ApiError, apiFetch } from '../lib/api';
import type { GoogleSheetsConfig } from './googleSheetsApi';

/**
 * Google Forms — one connected form per source.
 *
 * Connecting the Google ACCOUNT is NOT here. There is one Google account per
 * organization and Google Sheets already owns that flow, popup and all
 * (googleSheetsApi.ts: connectGoogle, loadPickerLibraries, pickDriveFile).
 * This module re-exports what the card needs and adds only what is specific to
 * forms, so there is no second OAuth popup, callback or BroadcastChannel.
 */

export { connectGoogle, disconnectGoogle, listGoogleConnections, loadPickerLibraries, pickerReady } from './googleSheetsApi';
export type { GoogleConnection, GoogleSheetsConfig } from './googleSheetsApi';

const BASE = '/integrations/google-forms';

export interface FormSource {
  id: string;
  name: string;
  formId: string | null;
  /** Opens the form in Google, where the script is installed. */
  formUrl: string | null;
  connectionId: string | null;
  /** NEEDS_MAPPING | PAUSED | ACTIVE */
  status: string | null;
  /** UNCONFIGURED | NEEDS_REVIEW | CONFIGURED */
  mappingStatus: string | null;
  /** Mapped and switched on: responses become leads. */
  live: boolean;
  /** Responses the script delivered while the form was still being set up. */
  waiting: number;
  lastDeliveryAt: string | null;
  lastLeadAt: string | null;
  lastFailureAt: string | null;
  lastPollAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  mappingNeedsReview: boolean;
  createdAt: string;
}

export interface FormQuestion {
  fieldKey: string;
  label: string;
  type: string;
  options: string[];
  /** The lead field this question fills, or null for "don't import". */
  target: string | null;
  consentCandidate: boolean;
}

export interface FormQuestions {
  source: FormSource;
  questions: FormQuestion[];
}

export interface FormScript {
  script: string;
  webhookUrl: string;
  formId: string;
}

export interface FormTest {
  /** We can still read the form with this organization's Google account. */
  formReadable: boolean;
  googleError: string | null;
  deliveries: number;
  /** Posted by the script on the form: the only proof that push works. */
  pushDeliveries: number;
  /** Fetched by the recovery poll instead — correct, but minutes late. */
  recoveredDeliveries: number;
  /** The script itself has delivered at least once. */
  scriptInstalled: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryOutcome: string | null;
  lastDeliveryReason: string | null;
  lastPollAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

/** These routes exist only where the server has GOOGLE_FORMS_ENABLED=1. */
export const isFormsDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

export const getGoogleFormsConfig = (): Promise<GoogleSheetsConfig> =>
  apiFetch<GoogleSheetsConfig>(`${BASE}/config`, { auth: true });

export const listFormSources = (): Promise<FormSource[]> =>
  apiFetch<{ sources: FormSource[] }>(`${BASE}/sources`, { auth: true }).then((r) => r.sources);

export const createFormSource = (body: { connectionId: string; formId: string }): Promise<FormSource> =>
  apiFetch<FormSource>(`${BASE}/sources`, { method: 'POST', auth: true, body });

/** `refresh` re-reads the form from Google, which is how a changed question is noticed. */
export const formQuestions = (id: string, refresh = false): Promise<FormQuestions> =>
  apiFetch<FormQuestions>(`${BASE}/sources/${id}/questions${refresh ? '?refresh=1' : ''}`, { auth: true });

export const saveFormMapping = (id: string, mappings: { sourceFieldKey: string; targetField: string }[]): Promise<FormSource> =>
  apiFetch<FormSource>(`${BASE}/sources/${id}/mapping`, { method: 'PUT', auth: true, body: { mappings } });

export const formScript = (id: string): Promise<FormScript> =>
  apiFetch<FormScript>(`${BASE}/sources/${id}/script`, { auth: true });

/** Switches the form on; `released` counts responses held during setup. */
export const activateFormSource = (id: string): Promise<FormSource & { released: number }> =>
  apiFetch<FormSource & { released: number }>(`${BASE}/sources/${id}/activate`, { method: 'POST', auth: true });

export const pauseFormSource = (id: string): Promise<FormSource> =>
  apiFetch<FormSource>(`${BASE}/sources/${id}/pause`, { method: 'POST', auth: true });

export const removeFormSource = (id: string): Promise<{ removed: true }> =>
  apiFetch<{ removed: true }>(`${BASE}/sources/${id}`, { method: 'DELETE', auth: true });

export const testFormSource = (id: string): Promise<FormTest> =>
  apiFetch<FormTest>(`${BASE}/sources/${id}/test`, { auth: true });

/** Runs the recovery check now rather than waiting for its turn. */
export const checkFormSource = (id: string): Promise<{ checked: boolean }> =>
  apiFetch<{ checked: boolean }>(`${BASE}/sources/${id}/check`, { method: 'POST', auth: true });

/** What a question can be mapped to, in the order an owner reads them. */
export const FORM_TARGETS: { value: string; label: string }[] = [
  { value: '', label: 'Don’t import' },
  { value: 'full_name', label: 'Full name' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'location', label: 'Preferred location' },
  { value: 'min_budget', label: 'Budget (min)' },
  { value: 'max_budget', label: 'Budget (max)' },
  { value: 'bedrooms', label: 'Bedrooms' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'buying_intent', label: 'Intent' },
  { value: 'financing_status', label: 'Financing' },
  { value: 'motivation', label: 'Motivation / notes' },
  { value: 'timezone', label: 'Time zone' },
  { value: 'consent_status', label: 'SMS/call consent' },
];

/**
 * One honest phrase for where a form stands, in the order that matters: a
 * broken delivery outranks "active", and an unmapped form outranks everything
 * because nothing happens until it is mapped.
 */
export function formStatus(s: FormSource): { label: string; tone: 'good' | 'warn' | 'bad' | 'idle' } {
  if (s.status === 'NEEDS_MAPPING' || s.mappingStatus === 'UNCONFIGURED') return { label: 'setup required', tone: 'warn' };
  if (s.mappingNeedsReview) return { label: 'mapping needs review', tone: 'warn' };
  if (s.lastErrorCode) return { label: 'delivery problem', tone: 'bad' };
  if (!s.live) return { label: 'paused', tone: 'idle' };
  if (!s.lastDeliveryAt) return { label: 'waiting for first response', tone: 'idle' };
  return { label: 'active', tone: 'good' };
}

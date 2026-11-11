import { apiFetch } from '../lib/api';

/**
 * Lead temperature from AI calls. Scoring is automatic once a call ends (the
 * backend reads Telnyx's post-call Insight); these are the owner's controls.
 * Owner-only on the server — an agent gets FORBIDDEN.
 */

export type Temperature = 'hot' | 'warm' | 'cold';

/**
 * One line of the office's points chart. A built-in line carries the field the
 * analysis records as `key`; a line the office added has only its label, which
 * the assistant reads and weighs like any other.
 */
export interface Criterion {
  key?: string;
  label: string;
  points: number;
}
export const MAX_CRITERIA = 20;
export const MAX_CRITERION_LABEL = 80;

export interface ScoringSettings {
  hotThreshold: number;
  warmThreshold: number;
  points: Criterion[];
}

/** What the server returns: the settings, plus the built-in chart for "Reset to defaults". */
export interface ScoringSettingsResponse extends ScoringSettings {
  defaultPoints: Criterion[];
}

/** voice_calls.extracted_intel.qualification, as the backend stores it. */
export interface Qualification {
  source: 'telnyx_insights' | 'transcript' | 'conversation';
  /** The assistant's own score and rating, or the backend's point rules for an analysis without one (and every call scored before). */
  scoredBy?: 'assistant' | 'rules';
  score: number;
  temperature: Temperature;
  reasons: { label: string; points: number }[];
  override: string | null;
  thresholds: { hot: number; warm: number };
  scoredAt: string;
}

export const getScoringSettings = () => apiFetch<ScoringSettingsResponse>('/lead-scoring/settings', { auth: true });

/** Saves and writes the chart into the Telnyx Insight; `warning` is set when that write was refused (it is retried at the next call). */
export const saveScoringSettings = (s: ScoringSettings) =>
  apiFetch<ScoringSettings & { warning: string | null }>('/lead-scoring/settings', { method: 'PUT', body: s, auth: true });

/** The qualification on a call's extractedIntel, if it has been scored. */
export function qualificationOf(extractedIntel: unknown): Qualification | null {
  if (!extractedIntel || typeof extractedIntel !== 'object') return null;
  const q = (extractedIntel as { qualification?: Qualification }).qualification;
  return q && typeof q.score === 'number' && Array.isArray(q.reasons) ? q : null;
}

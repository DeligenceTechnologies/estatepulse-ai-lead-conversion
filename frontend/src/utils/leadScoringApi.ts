import { apiFetch } from '../lib/api';

/**
 * Lead temperature from AI calls. Scoring is automatic once a call ends (the
 * backend reads Telnyx's post-call Insight); these are the owner's controls.
 * Owner-only on the server — an agent gets FORBIDDEN.
 */

export type Temperature = 'hot' | 'warm' | 'cold';

export interface Thresholds {
  hotThreshold: number;
  warmThreshold: number;
}

/** Where a call's qualification came from: the provider's own post-call analysis, or our read of the transcript. */
export type QualificationSource = 'telnyx_insights' | 'retell_analysis' | 'transcript';

export const SOURCE_LABEL: Record<QualificationSource, string> = {
  telnyx_insights: 'scored when the call ended',
  retell_analysis: 'scored from Retell’s post-call analysis',
  transcript: 'scored from the transcript',
};

/** voice_calls.extracted_intel.qualification, as the backend stores it. */
export interface Qualification {
  source: QualificationSource;
  score: number;
  temperature: Temperature;
  reasons: { label: string; points: number }[];
  override: string | null;
  thresholds: { hot: number; warm: number };
  scoredAt: string;
}

export const getThresholds = () => apiFetch<Thresholds>('/lead-scoring/settings', { auth: true });

export const saveThresholds = (t: Thresholds) =>
  apiFetch<Thresholds>('/lead-scoring/settings', { method: 'PUT', body: t, auth: true });

/** The qualification on a call's extractedIntel, if it has been scored. */
export function qualificationOf(extractedIntel: unknown): Qualification | null {
  if (!extractedIntel || typeof extractedIntel !== 'object') return null;
  const q = (extractedIntel as { qualification?: Qualification }).qualification;
  return q && typeof q.score === 'number' && Array.isArray(q.reasons) ? q : null;
}

/** Why a call could not be scored (the provider's analysis never came), when the backend noted it and no score followed. */
export function analysisUnavailableOf(extractedIntel: unknown): string | null {
  if (!extractedIntel || typeof extractedIntel !== 'object' || qualificationOf(extractedIntel)) return null;
  const a = (extractedIntel as { analysis?: { status?: string; reason?: string } }).analysis;
  return a?.status === 'unavailable' ? (a.reason ?? 'The call analysis is unavailable') : null;
}

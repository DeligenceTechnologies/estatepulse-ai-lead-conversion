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

/** voice_calls.extracted_intel.qualification, as the backend stores it. */
export interface Qualification {
  source: 'telnyx_insights' | 'transcript';
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

export const classifyCall = (callId: string) =>
  apiFetch<Qualification>(`/lead-scoring/calls/${callId}/classify`, { method: 'POST', auth: true });

/** The qualification on a call's extractedIntel, if it has been scored. */
export function qualificationOf(extractedIntel: unknown): Qualification | null {
  if (!extractedIntel || typeof extractedIntel !== 'object') return null;
  const q = (extractedIntel as { qualification?: Qualification }).qualification;
  return q && typeof q.score === 'number' && Array.isArray(q.reasons) ? q : null;
}

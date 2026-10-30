import { apiFetch } from '../lib/api';

/**
 * Lead temperature from AI calls. Scoring is automatic once a call ends (the
 * backend reads Telnyx's post-call Insight); these are the owner's controls.
 * Owner-only on the server — an agent gets FORBIDDEN.
 */

export type Temperature = 'hot' | 'warm' | 'cold';

/** Everything a caller can say that moves the score, with the label the form shows for it. */
export const POINT_FIELDS = [
  { key: 'within_30_days', label: 'Buying within 30 days' },
  { key: '1_3_months', label: 'Buying within 1–3 months' },
  { key: '3_6_months', label: 'Buying within 3–6 months' },
  { key: 'over_6_months', label: 'Buying in over 6 months' },
  { key: 'budget_identified', label: 'Budget identified' },
  { key: 'location_identified', label: 'Location identified' },
  { key: 'pre_approved', label: 'Pre-approved or cash buyer' },
  { key: 'appointment_requested', label: 'Appointment requested' },
  { key: 'high_engagement', label: 'High engagement' },
  { key: 'not_interested', label: 'Not interested' },
  { key: 'invalid_lead', label: 'Invalid lead (wrong number, spam)' },
] as const;
export type PointKey = (typeof POINT_FIELDS)[number]['key'];
/** The office's points chart: what each thing is worth, each a whole number from -100 to 100. */
export type Points = Record<PointKey, number>;

export interface ScoringSettings {
  hotThreshold: number;
  warmThreshold: number;
  points: Points;
}

/** voice_calls.extracted_intel.qualification, as the backend stores it. */
export interface Qualification {
  source: 'telnyx_insights' | 'transcript';
  /** The assistant's own score and rating, or the backend's point rules for an analysis without one (and every call scored before). */
  scoredBy?: 'assistant' | 'rules';
  score: number;
  temperature: Temperature;
  reasons: { label: string; points: number }[];
  override: string | null;
  thresholds: { hot: number; warm: number };
  scoredAt: string;
}

export const getScoringSettings = () => apiFetch<ScoringSettings>('/lead-scoring/settings', { auth: true });

export const saveScoringSettings = (s: ScoringSettings) =>
  apiFetch<ScoringSettings>('/lead-scoring/settings', { method: 'PUT', body: s, auth: true });

/** The qualification on a call's extractedIntel, if it has been scored. */
export function qualificationOf(extractedIntel: unknown): Qualification | null {
  if (!extractedIntel || typeof extractedIntel !== 'object') return null;
  const q = (extractedIntel as { qualification?: Qualification }).qualification;
  return q && typeof q.score === 'number' && Array.isArray(q.reasons) ? q : null;
}

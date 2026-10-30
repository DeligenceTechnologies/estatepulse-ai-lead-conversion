import { EXTRACTION_JSON_SCHEMA, FINANCING, TIMELINES, parseExtraction, type Extraction } from '@/telnyx/lead-scoring';

type RetellField =
  | { type: 'string' | 'boolean' | 'number'; name: string; description: string }
  | { type: 'enum'; name: string; description: string; choices: string[] };

const CALLER_ONLY = 'Answer strictly from what the caller (user) said; the agent’s own questions are not answers.';

/**
 * The lead-qualification fields, as Retell post-call analysis fields: the same
 * names and descriptions the Telnyx Insight uses, so one scorer reads both.
 * The SMS agent asks the same of a text chat (post_chat_analysis_data).
 */
export const POST_CALL_ANALYSIS_DATA: RetellField[] = Object.entries(EXTRACTION_JSON_SCHEMA.properties).map(([name, spec]) => {
  const p = spec as { type: string | readonly string[]; enum?: readonly (string | null)[]; description: string };
  const description = `${p.description} ${CALLER_ONLY}`;
  const types = Array.isArray(p.type) ? p.type : [p.type];
  if (p.enum) return { type: 'enum', name, description, choices: p.enum.filter((c): c is string => c !== null) };
  if (types.includes('boolean')) return { type: 'boolean', name, description: `${description} False if it was never said.` };
  if (types.includes('number') || types.includes('integer')) return { type: 'number', name, description };
  return { type: 'string', name, description };
});

/**
 * Retell's `call_analysis` (or a chat's `chat_analysis`) as our Extraction.
 * Missing booleans read false and a missing timeline reads unknown, as the
 * extraction instructions say; out-of-range values are dropped rather than
 * failing the whole call. Null when there is no custom analysis to read.
 */
export function extractionFromRetell(analysis: unknown): Extraction | null {
  const a = (analysis ?? {}) as { custom_analysis_data?: unknown; call_summary?: unknown; chat_summary?: unknown };
  const data = a.custom_analysis_data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) return null;
  const d = data as Record<string, unknown>;

  const bool = (k: string) => d[k] === true || d[k] === 'true';
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const num = (k: string, min: number, max: number) => {
    const n = typeof d[k] === 'number' ? (d[k] as number) : typeof d[k] === 'string' && String(d[k]).trim() ? Number(d[k]) : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const oneOf = <T extends string>(k: string, list: readonly T[]) => (list.includes(d[k] as T) ? (d[k] as T) : null);
  const bedrooms = num('bedrooms', 0, 20);

  return parseExtraction({
    timeline: oneOf('timeline', TIMELINES) ?? 'unknown',
    budget_identified: bool('budget_identified'),
    location_identified: bool('location_identified'),
    pre_approved: bool('pre_approved'),
    appointment_requested: bool('appointment_requested'),
    high_engagement: bool('high_engagement'),
    not_interested: bool('not_interested'),
    invalid_lead: bool('invalid_lead'),
    human_requested: bool('human_requested'),
    callback_requested: bool('callback_requested'),
    summary: text(d.summary, 2000) ?? text(a.call_summary, 2000) ?? text(a.chat_summary, 2000) ?? '',
    budget_min: num('budget_min', 0, 1_000_000_000),
    budget_max: num('budget_max', 0, 1_000_000_000),
    location: text(d.location, 255),
    bedrooms: bedrooms == null ? null : Math.round(bedrooms),
    financing: oneOf('financing', FINANCING),
    motivation: text(d.motivation, 1000),
    // Asked since the journey work; an agent created before then never answers them, and the disposition decides instead.
    ...('reached_person' in d ? { reached_person: bool('reached_person') } : {}),
    ...('do_not_contact' in d ? { do_not_contact: bool('do_not_contact') } : {}),
  });
}

/**
 * Retell's own verdict that the call went to voicemail (`in_voicemail`), as
 * the extraction the scorer reads for a call that reached no one: the lead is
 * left as they were, nothing is scored from the machine's greeting.
 */
export function voicemailExtraction(analysis: unknown): Extraction {
  const a = (analysis ?? {}) as { call_summary?: unknown };
  return parseExtraction({
    timeline: 'unknown',
    budget_identified: false,
    location_identified: false,
    pre_approved: false,
    appointment_requested: false,
    high_engagement: false,
    not_interested: false,
    invalid_lead: false,
    human_requested: false,
    callback_requested: false,
    summary: typeof a.call_summary === 'string' && a.call_summary.trim() ? a.call_summary.trim().slice(0, 2000) : 'Reached voicemail',
    budget_min: null,
    budget_max: null,
    location: null,
    bedrooms: null,
    financing: null,
    motivation: null,
    reached_person: false,
  })!;
}

export const inVoicemail = (analysis: unknown): boolean => (analysis as { in_voicemail?: unknown } | null)?.in_voicemail === true;

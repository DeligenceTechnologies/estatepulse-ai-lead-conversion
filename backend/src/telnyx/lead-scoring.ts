import { z } from 'zod';

/**
 * Lead temperature from an AI call, in two halves that never mix:
 *
 *  1. EXTRACTION — the AI reads the conversation and answers fixed questions
 *     (timeline bucket, budget mentioned, pre-approved, ...). Telnyx does this,
 *     either as a post-call Insight or, for a call recorded before the Insight
 *     existed, through its chat API over the stored transcript.
 *  2. SCORING — this file. Plain arithmetic over the extracted facts, so the
 *     same facts always give the same score and every point has a reason the
 *     office can read. The AI never picks the number or the temperature.
 *
 * Nothing here does I/O; it is unit-tested in lead-scoring.spec.ts.
 */

export const TIMELINES = ['within_30_days', '1_3_months', '3_6_months', 'over_6_months', 'unknown'] as const;
export type Timeline = (typeof TIMELINES)[number];

/** What the AI must return. Every field is required so "not mentioned" is an explicit false, never a gap. */
export const extractionSchema = z.object({
  timeline: z.enum(TIMELINES),
  budget_identified: z.boolean(),
  location_identified: z.boolean(),
  pre_approved: z.boolean(),
  appointment_requested: z.boolean(),
  high_engagement: z.boolean(),
  not_interested: z.boolean(),
  invalid_lead: z.boolean(),
  human_requested: z.boolean(),
  summary: z.string().max(2000),
});
export type Extraction = z.infer<typeof extractionSchema>;

/**
 * The same shape as JSON Schema, for Telnyx. Hand-written rather than generated
 * because it is the contract with the model, and the field descriptions are
 * part of the prompt.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'timeline',
    'budget_identified',
    'location_identified',
    'pre_approved',
    'appointment_requested',
    'high_engagement',
    'not_interested',
    'invalid_lead',
    'human_requested',
    'summary',
  ],
  properties: {
    timeline: {
      type: 'string',
      enum: [...TIMELINES],
      description:
        'When the caller intends to buy. within_30_days, 1_3_months, 3_6_months, over_6_months, or unknown if they never said.',
    },
    budget_identified: { type: 'boolean', description: 'The caller stated a budget, price range or price ceiling.' },
    location_identified: { type: 'boolean', description: 'The caller named a city, area, neighbourhood or zip code.' },
    pre_approved: { type: 'boolean', description: 'The caller said they are pre-approved for a mortgage or buying all cash.' },
    appointment_requested: {
      type: 'boolean',
      description:
        'The caller asked for, or clearly agreed to, a meeting, showing or consultation. Declining a proposed time without agreeing to another is false.',
    },
    high_engagement: {
      type: 'boolean',
      description: 'The caller answered questions willingly and in substance, not with one-word or evasive replies.',
    },
    not_interested: { type: 'boolean', description: 'The caller said they are not interested or asked not to be contacted.' },
    invalid_lead: {
      type: 'boolean',
      description: 'Wrong number, spam, a test, or the person never enquired about buying a home.',
    },
    human_requested: { type: 'boolean', description: 'The caller asked to speak with a real person or agent.' },
    summary: { type: 'string', description: 'Two or three sentences on who the caller is and what they want.' },
  },
} as const;

export const EXTRACTION_INSTRUCTIONS =
  'You are reviewing a phone call between an AI assistant for a real estate brokerage and a prospective home buyer. ' +
  'Answer every field strictly from what the CALLER said. Do not guess: if something was not said, answer false, ' +
  'or "unknown" for the timeline. The assistant’s own questions are not answers.';

/** Points per fact. The table from the milestone spec; not yet editable per office. */
export const POINTS = {
  timeline: { within_30_days: 25, '1_3_months': 20, '3_6_months': 10, over_6_months: 0, unknown: 0 } as Record<Timeline, number>,
  budget_identified: 10,
  location_identified: 10,
  pre_approved: 15,
  appointment_requested: 20,
  high_engagement: 10,
  not_interested: -30,
  invalid_lead: -100,
} as const;

export const DEFAULT_THRESHOLDS = { hot: 75, warm: 45 } as const;
export interface Thresholds {
  hot: number;
  warm: number;
}

export type Temperature = 'hot' | 'warm' | 'cold';

export interface ScoreReason {
  label: string;
  points: number;
}

export interface ScoreResult {
  /** 0–100, the range the leads_score_check constraint allows. */
  score: number;
  temperature: Temperature;
  reasons: ScoreReason[];
  /** Why the temperature is what it is, when that is not simply the score. */
  override: string | null;
}

const TIMELINE_LABEL: Record<Timeline, string> = {
  within_30_days: 'Buying within 30 days',
  '1_3_months': 'Buying within 1–3 months',
  '3_6_months': 'Buying within 3–6 months',
  over_6_months: 'Buying in over 6 months',
  unknown: 'Timeline unknown',
};

export function scoreLead(x: Extraction, t: Thresholds = DEFAULT_THRESHOLDS): ScoreResult {
  const reasons: ScoreReason[] = [];
  const add = (label: string, points: number) => {
    if (points !== 0) reasons.push({ label, points });
  };

  add(TIMELINE_LABEL[x.timeline], POINTS.timeline[x.timeline]);
  if (x.budget_identified) add('Budget identified', POINTS.budget_identified);
  if (x.location_identified) add('Location identified', POINTS.location_identified);
  if (x.pre_approved) add('Pre-approved', POINTS.pre_approved);
  if (x.appointment_requested) add('Appointment requested', POINTS.appointment_requested);
  if (x.high_engagement) add('High engagement', POINTS.high_engagement);
  if (x.not_interested) add('Not interested', POINTS.not_interested);
  if (x.invalid_lead) add('Invalid lead', POINTS.invalid_lead);

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  let temperature: Temperature = score >= t.hot ? 'hot' : score >= t.warm ? 'warm' : 'cold';
  let override: string | null = null;

  // Asking for a person is a hot lead whatever the score (milestone rule), but
  // not when the AI judged the lead invalid: a wrong number asking "who is
  // this?" must not jump an agent's queue.
  if (x.human_requested && !x.invalid_lead && temperature !== 'hot') {
    temperature = 'hot';
    override = 'Asked to speak with a person — routed as hot';
  }

  return { score, temperature, reasons, override };
}

/**
 * The AI's answer, validated. Accepts a JSON string or an already-parsed
 * object, because Telnyx documents both for an Insight result. Anything that
 * does not match the schema is null — never a partially-trusted guess.
 */
export function parseExtraction(raw: unknown): Extraction | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = extractionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const thresholdsSchema = z
  .object({
    hotThreshold: z.number().int().min(1).max(100),
    warmThreshold: z.number().int().min(1).max(100),
  })
  .strict()
  .refine((v) => v.warmThreshold < v.hotThreshold, {
    message: 'The warm threshold must be lower than the hot threshold',
    path: ['warmThreshold'],
  });
export type ThresholdsInput = z.infer<typeof thresholdsSchema>;

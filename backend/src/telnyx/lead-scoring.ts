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

export const FINANCING = ['pre_approved', 'cash', 'needs_financing', 'unknown'] as const;
export type Financing = (typeof FINANCING)[number];

/**
 * A detail the caller may or may not have given. Nullable, and optional so a
 * result produced before these fields existed (an Insight defined earlier)
 * still parses and still scores.
 */
const maybe = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

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
  // The details themselves, written onto the lead (leadDetailsFrom).
  budget_min: maybe(z.number().nonnegative().max(1_000_000_000)),
  budget_max: maybe(z.number().nonnegative().max(1_000_000_000)),
  location: maybe(z.string().max(255)),
  bedrooms: maybe(z.number().int().min(0).max(20)),
  financing: maybe(z.enum(FINANCING)),
  motivation: maybe(z.string().max(1000)),
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
    'budget_min',
    'budget_max',
    'location',
    'bedrooms',
    'financing',
    'motivation',
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
    budget_min: {
      type: ['number', 'null'],
      description:
        'Lowest price the caller mentioned, in whole dollars (e.g. "150 to 220 thousand" -> 150000). null if none. ' +
        'Use the figure the caller confirmed when the assistant restated it.',
    },
    budget_max: {
      type: ['number', 'null'],
      description: 'Highest price, in whole dollars (e.g. 220000); for a single figure like "up to 500k", 500000. null if none.',
    },
    location: {
      type: ['string', 'null'],
      description: 'Where they want to buy (city, area, neighbourhood or zip), as the caller said it. null if not said.',
    },
    bedrooms: { type: ['integer', 'null'], description: 'Bedrooms they need, as a whole number. null if not said.' },
    financing: {
      type: ['string', 'null'],
      enum: [...FINANCING, null],
      description: 'pre_approved (has mortgage pre-approval), cash, needs_financing (still sorting a loan), or unknown.',
    },
    motivation: {
      type: ['string', 'null'],
      description:
        'The reason the caller gave for moving, in a few words of their own (e.g. "relocating for work", "growing family"). ' +
        'null if they did not say why. Not a description of how engaged they were.',
    },
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

const TIMELINE_TEXT: Record<Timeline, string | null> = {
  within_30_days: 'Within 30 days',
  '1_3_months': '1–3 months',
  '3_6_months': '3–6 months',
  over_6_months: '6+ months',
  unknown: null,
};

const FINANCING_TEXT: Record<Financing, string | null> = {
  pre_approved: 'Pre-approved',
  cash: 'Cash buyer',
  needs_financing: 'Needs financing',
  unknown: null,
};

/**
 * The lead columns a call can fill, from what the caller said. Only details
 * actually given are returned: a call that never mentioned the budget must
 * not wipe a budget the lead already has. Keys are `leads` column names.
 */
export function leadDetailsFrom(x: Extraction): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const text = (v: string | null | undefined) => v?.trim() || null;

  let min = x.budget_min ?? null;
  let max = x.budget_max ?? null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  if (min != null) out.min_budget = min;
  if (max != null) out.max_budget = max;

  const location = text(x.location);
  if (location) out.location = location.slice(0, 255);
  if (x.bedrooms != null) out.bedrooms = x.bedrooms;

  const timeline = TIMELINE_TEXT[x.timeline];
  if (timeline) out.timeline = timeline;

  const financing = x.financing ? FINANCING_TEXT[x.financing] : null;
  if (financing) {
    out.financing_status = financing;
    out.all_cash = x.financing === 'cash';
  }

  // A real reason has words; a lone token like "high_engagement" is the model
  // echoing a field name, not something the caller said.
  const motivation = text(x.motivation);
  if (motivation && /\s/.test(motivation)) out.motivation = motivation.slice(0, 1000);
  return out;
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

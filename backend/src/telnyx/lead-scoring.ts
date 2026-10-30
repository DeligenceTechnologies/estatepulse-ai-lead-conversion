import { z } from 'zod';

export const TIMELINES = ['within_30_days', '1_3_months', '3_6_months', 'over_6_months', 'unknown'] as const;
export type Timeline = (typeof TIMELINES)[number];

export const FINANCING = ['pre_approved', 'cash', 'needs_financing', 'unknown'] as const;
export type Financing = (typeof FINANCING)[number];

export const TEMPERATURES = ['hot', 'warm', 'cold'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

const maybe = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

export const extractionSchema = z.object({
  /** Absent from analyses made before it was asked: the call then counts as its disposition says. */
  reached_person: maybe(z.boolean()),
  /** Absent from analyses made before it was asked: "not interested" alone never sets do-not-contact. */
  do_not_contact: maybe(z.boolean()),
  timeline: z.enum(TIMELINES),
  budget_identified: z.boolean(),
  location_identified: z.boolean(),
  pre_approved: z.boolean(),
  appointment_requested: z.boolean(),
  high_engagement: z.boolean(),
  not_interested: z.boolean(),
  invalid_lead: z.boolean(),
  human_requested: z.boolean(),
  callback_requested: maybe(z.boolean()),
  summary: z.string().max(2000),
  budget_min: maybe(z.number().nonnegative().max(1_000_000_000)),
  budget_max: maybe(z.number().nonnegative().max(1_000_000_000)),
  location: maybe(z.string().max(255)),
  bedrooms: maybe(z.number().int().min(0).max(20)),
  financing: maybe(z.enum(FINANCING)),
  motivation: maybe(z.string().max(1000)),
  /** The assistant's own verdict. Absent from analyses made before it was asked to score: the rules score those. */
  lead_score: maybe(z.number().min(0).max(100)),
  lead_temperature: maybe(z.enum(TEMPERATURES)),
  score_reasons: maybe(z.string().max(1000)),
});
export type Extraction = z.infer<typeof extractionSchema>;

export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reached_person',
    'do_not_contact',
    'timeline',
    'budget_identified',
    'location_identified',
    'pre_approved',
    'appointment_requested',
    'high_engagement',
    'not_interested',
    'invalid_lead',
    'human_requested',
    'callback_requested',
    'summary',
    'budget_min',
    'budget_max',
    'location',
    'bedrooms',
    'financing',
    'motivation',
    'lead_score',
    'lead_temperature',
    'score_reasons',
  ],
  properties: {
    reached_person: {
      type: 'boolean',
      description:
        'A real person answered and spoke with the assistant. False for voicemail, an answering machine, ' +
        'an automated phone menu, or a call where only the assistant spoke.',
    },
    do_not_contact: {
      type: 'boolean',
      description:
        'The caller asked not to be called, texted or contacted again (for example "stop calling me", "take me off your list"). ' +
        'Saying they are not interested is not enough.',
    },
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
    not_interested: { type: 'boolean', description: 'The caller said they are not interested in buying or in our help.' },
    invalid_lead: {
      type: 'boolean',
      description: 'Wrong number, spam, a test, or the person never enquired about buying a home.',
    },
    human_requested: { type: 'boolean', description: 'The caller asked to speak with a real person or agent.' },
    callback_requested: {
      type: 'boolean',
      description: 'The caller asked to be called back at another time instead of talking now.',
    },
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
    lead_score: {
      type: 'integer',
      description: 'Your score for this lead, 0 to 100, by the scoring rules in the instructions.',
    },
    lead_temperature: {
      type: 'string',
      enum: [...TEMPERATURES],
      description:
        'hot, warm or cold, from lead_score and the thresholds in the instructions. ' +
        'A caller who asked to speak with a person is hot whatever the score, unless the lead is invalid.',
    },
    score_reasons: {
      type: 'string',
      description:
        'Every reason behind the score with its points, separated by "; " (e.g. "Buying within 30 days +25; Budget identified +10; Not interested -30").',
    },
  },
} as const;

export const EXTRACTION_INSTRUCTIONS =
  'You are reviewing a phone call between an AI assistant for a real estate brokerage and a prospective home buyer. ' +
  'Answer every field strictly from what the CALLER said. Do not guess: if something was not said, answer false, ' +
  'or "unknown" for the timeline. The assistant’s own questions are not answers.';

/**
 * What the analysis is asked to do: extract the facts, then score and rate the
 * lead itself. The point weights are a guide for its judgement (partial or
 * mixed answers included), and the office's own thresholds draw the lines, so
 * the Insight is written again whenever those change.
 */
export function scoringInstructions({ thresholds: t, points: p }: ScoringSettings): string {
  const s = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return (
    `${EXTRACTION_INSTRUCTIONS} Then score the lead yourself as lead_score, 0 to 100, weighing what the caller said by these points ` +
    'and using your judgement for partial or mixed answers: ' +
    `buying within 30 days ${s(p.within_30_days)}, within 1–3 months ${s(p['1_3_months'])}, within 3–6 months ${s(p['3_6_months'])}, in over 6 months ${s(p.over_6_months)}; ` +
    `budget stated ${s(p.budget_identified)}; location named ${s(p.location_identified)}; pre-approved or paying cash ${s(p.pre_approved)}; ` +
    `appointment requested ${s(p.appointment_requested)}; engaged, substantive answers ${s(p.high_engagement)}; ` +
    `not interested ${s(p.not_interested)}; wrong number, spam or never enquired ${s(p.invalid_lead)}. ` +
    `Set lead_temperature to hot at ${t.hot} or above, warm at ${t.warm} or above, otherwise cold; ` +
    'a caller who asked to speak with a person is hot unless the lead is invalid. ' +
    'List every reason behind the score, with its points, in score_reasons.'
  );
}

/** Everything a caller can say that moves the score; a timeline they never gave moves nothing. */
export const POINT_KEYS = [
  'within_30_days',
  '1_3_months',
  '3_6_months',
  'over_6_months',
  'budget_identified',
  'location_identified',
  'pre_approved',
  'appointment_requested',
  'high_engagement',
  'not_interested',
  'invalid_lead',
] as const;
export type PointKey = (typeof POINT_KEYS)[number];
export type Points = Record<PointKey, number>;

const pointValue = z.number().int().min(-100).max(100);
/** The office's own chart: what each thing is worth, each a whole number from -100 to 100. */
export const pointsSchema = z.object(Object.fromEntries(POINT_KEYS.map((k) => [k, pointValue])) as Record<PointKey, typeof pointValue>).strict();

export const DEFAULT_POINTS: Points = {
  within_30_days: 25,
  '1_3_months': 20,
  '3_6_months': 10,
  over_6_months: 0,
  budget_identified: 10,
  location_identified: 10,
  pre_approved: 15,
  appointment_requested: 20,
  high_engagement: 10,
  not_interested: -30,
  invalid_lead: -100,
};

export const DEFAULT_THRESHOLDS = { hot: 75, warm: 45 } as const;
export interface Thresholds {
  hot: number;
  warm: number;
}

/** How the office scores: its points chart and where hot and warm begin. */
export interface ScoringSettings {
  thresholds: Thresholds;
  points: Points;
}

/** The settings as org_settings holds them: no row, or no (valid) chart, means the defaults. */
export function scoringSettingsFrom(row: { leadHotThreshold: number; leadWarmThreshold: number; leadScorePoints: unknown } | null): ScoringSettings {
  const points = pointsSchema.safeParse(row?.leadScorePoints);
  return {
    thresholds: { hot: row?.leadHotThreshold ?? DEFAULT_THRESHOLDS.hot, warm: row?.leadWarmThreshold ?? DEFAULT_THRESHOLDS.warm },
    points: points.success ? points.data : DEFAULT_POINTS,
  };
}

export interface ScoreReason {
  label: string;
  points: number;
}

export interface ScoreResult {
  score: number;
  temperature: Temperature;
  reasons: ScoreReason[];
  override: string | null;
}

const TIMELINE_LABEL: Record<Timeline, string> = {
  within_30_days: 'Buying within 30 days',
  '1_3_months': 'Buying within 1–3 months',
  '3_6_months': 'Buying within 3–6 months',
  over_6_months: 'Buying in over 6 months',
  unknown: 'Timeline unknown',
};

export function scoreLead(x: Extraction, t: Thresholds = DEFAULT_THRESHOLDS, p: Points = DEFAULT_POINTS): ScoreResult {
  const reasons: ScoreReason[] = [];
  const add = (label: string, points: number) => {
    if (points !== 0) reasons.push({ label, points });
  };

  add(TIMELINE_LABEL[x.timeline], x.timeline === 'unknown' ? 0 : p[x.timeline]);
  if (x.budget_identified) add('Budget identified', p.budget_identified);
  if (x.location_identified) add('Location identified', p.location_identified);
  if (x.pre_approved) add('Pre-approved', p.pre_approved);
  if (x.appointment_requested) add('Appointment requested', p.appointment_requested);
  if (x.high_engagement) add('High engagement', p.high_engagement);
  if (x.not_interested) add('Not interested', p.not_interested);
  if (x.invalid_lead) add('Invalid lead', p.invalid_lead);

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  let temperature: Temperature = score >= t.hot ? 'hot' : score >= t.warm ? 'warm' : 'cold';
  let override: string | null = null;

  if (x.human_requested && !x.invalid_lead && temperature !== 'hot') {
    temperature = 'hot';
    override = 'Asked to speak with a person — routed as hot';
  }

  return { score, temperature, reasons, override };
}

/**
 * The assistant's own verdict, when the analysis carries one: its score and
 * temperature as given and each reason it listed. A rating that crosses the
 * office's lines is kept but said so, and a caller who asked for a person is
 * hot whoever scores. Null for an analysis made before the assistant was asked
 * to score, which the rules score instead.
 */
export function assistantScore(x: Extraction, t: Thresholds): ScoreResult | null {
  if (x.lead_score == null || !x.lead_temperature) return null;
  const score = Math.round(Math.max(0, Math.min(100, x.lead_score)));
  const reasons: ScoreReason[] = (x.score_reasons ?? '')
    .split(/;|\n/)
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => ({ label, points: 0 }));

  let temperature: Temperature = x.lead_temperature;
  let override: string | null = null;
  const byThresholds: Temperature = score >= t.hot ? 'hot' : score >= t.warm ? 'warm' : 'cold';
  if (temperature !== byThresholds) override = `The assistant rated this lead ${temperature} at ${score}, which reads ${byThresholds} by your thresholds`;
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

export interface LeadDetails {
  minBudget?: number;
  maxBudget?: number;
  location?: string;
  bedrooms?: number;
  timeline?: string;
  financingStatus?: string;
  motivation?: string;
}

export function leadDetailsFrom(x: Extraction): LeadDetails {
  const out: LeadDetails = {};
  const text = (v: string | null | undefined) => v?.trim() || null;

  let min = x.budget_min ?? null;
  let max = x.budget_max ?? null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  if (min != null) out.minBudget = min;
  if (max != null) out.maxBudget = max;

  const location = text(x.location);
  if (location) out.location = location.slice(0, 255);
  if (x.bedrooms != null) out.bedrooms = x.bedrooms;

  const timeline = TIMELINE_TEXT[x.timeline];
  if (timeline) out.timeline = timeline;

  const financing = x.financing ? FINANCING_TEXT[x.financing] : null;
  if (financing) {
    out.financingStatus = financing;
  }

  const motivation = text(x.motivation);
  if (motivation && /\s/.test(motivation)) out.motivation = motivation.slice(0, 1000);
  return out;
}

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

import { createHash } from 'node:crypto';
import { EXTRACTION_INSTRUCTIONS, EXTRACTION_JSON_SCHEMA } from './lead-scoring';

/**
 * Each org's qualification questions, and the lead's memory of them: what the
 * lead already told us on a call or in a text (so the assistant confirms
 * instead of re-asking) and what is still open.
 *
 * Built-in questions are answered by the fixed extraction fields and live on
 * the lead's own columns (budget, timeline, ...). Custom questions are
 * extracted into `answers` and kept in `Lead.qualificationAnswers`.
 */

export const QUESTION_TYPES = ['text', 'number', 'boolean', 'choice'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const BUILTIN_KEYS = ['timeline', 'location', 'budget', 'bedrooms', 'financing', 'motivation'] as const;
export type BuiltinKey = (typeof BUILTIN_KEYS)[number];

export const MAX_QUESTIONS = 30;
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export interface Question {
  key: string;
  label: string;
  question: string;
  type: QuestionType;
  options?: string[];
  enabled: boolean;
  builtin: boolean;
}

export const DEFAULT_QUESTIONS: Question[] = [
  { key: 'timeline', label: 'Timeline', question: 'When are you hoping to buy?', type: 'text', enabled: true, builtin: true },
  { key: 'location', label: 'Location', question: 'Which area or neighbourhood are you looking in?', type: 'text', enabled: true, builtin: true },
  { key: 'budget', label: 'Budget', question: 'What price range are you working with?', type: 'text', enabled: true, builtin: true },
  { key: 'bedrooms', label: 'Bedrooms', question: 'How many bedrooms do you need?', type: 'number', enabled: true, builtin: true },
  { key: 'financing', label: 'Financing', question: 'Are you pre-approved for a mortgage, buying cash, or still sorting financing?', type: 'text', enabled: true, builtin: true },
  { key: 'motivation', label: 'Motivation', question: 'What is prompting the move?', type: 'text', enabled: true, builtin: true },
];

const isBuiltin = (key: string): key is BuiltinKey => (BUILTIN_KEYS as readonly string[]).includes(key);

/**
 * A saved list made safe: unknown or duplicate keys dropped, built-ins always
 * present (an org disables one rather than deleting it), at most MAX_QUESTIONS.
 */
export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return DEFAULT_QUESTIONS.map((q) => ({ ...q }));
  const seen = new Set<string>();
  const out: Question[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key ?? '').trim();
    if (!KEY_PATTERN.test(key) || seen.has(key)) continue;
    const builtin = isBuiltin(key);
    const base = builtin ? DEFAULT_QUESTIONS.find((q) => q.key === key)! : null;
    const type = builtin ? base!.type : (QUESTION_TYPES as readonly string[]).includes(String(item.type)) ? (item.type as QuestionType) : 'text';
    const options =
      type === 'choice' && Array.isArray(item.options)
        ? [...new Set((item.options as unknown[]).map((o) => String(o).trim()).filter(Boolean))].slice(0, 20)
        : undefined;
    if (type === 'choice' && !options?.length) continue;
    const question = String(item.question ?? '').trim().slice(0, 300) || base?.question || '';
    if (!question) continue;
    seen.add(key);
    out.push({
      key,
      label: String(item.label ?? '').trim().slice(0, 80) || base?.label || key,
      question,
      type,
      ...(options ? { options } : {}),
      enabled: item.enabled !== false,
      builtin,
    });
  }
  for (const q of DEFAULT_QUESTIONS) if (!seen.has(q.key)) out.push({ ...q, enabled: false });
  return out.slice(0, MAX_QUESTIONS + BUILTIN_KEYS.length);
}

const customEnabled = (questions: Question[]) => questions.filter((q) => q.enabled && !q.builtin);

/** Changes whenever what the Insight extracts changes. */
export function questionsHash(questions: Question[]): string {
  const relevant = customEnabled(questions).map(({ key, question, type, options }) => ({ key, question, type, options }));
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

function answerProperty(q: Question): Record<string, unknown> {
  const description = `The lead's answer to: "${q.question}". null if they did not answer it in this conversation.`;
  switch (q.type) {
    case 'number':
      return { type: ['number', 'null'], description };
    case 'boolean':
      return { type: ['boolean', 'null'], description };
    case 'choice':
      return { type: ['string', 'null'], enum: [...(q.options ?? []), null], description };
    default:
      return { type: ['string', 'null'], description: `${description} A few words, as the lead put it.` };
  }
}

/** The fixed extraction schema plus an `answers` object for the org's custom questions. */
export function extractionJsonSchemaFor(questions: Question[]): Record<string, unknown> {
  const custom = customEnabled(questions);
  if (!custom.length) return EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>;
  return {
    ...EXTRACTION_JSON_SCHEMA,
    required: [...EXTRACTION_JSON_SCHEMA.required, 'answers'],
    properties: {
      ...EXTRACTION_JSON_SCHEMA.properties,
      answers: {
        type: 'object',
        additionalProperties: false,
        required: custom.map((q) => q.key),
        properties: Object.fromEntries(custom.map((q) => [q.key, answerProperty(q)])),
        description: 'Answers to the brokerage’s own qualification questions.',
      },
    },
  };
}

export function extractionInstructionsFor(questions: Question[]): string {
  if (!customEnabled(questions).length) return EXTRACTION_INSTRUCTIONS;
  return (
    EXTRACTION_INSTRUCTIONS +
    ' For "answers", fill a question only when the lead clearly answered it in THIS conversation, otherwise null. ' +
    'If the lead corrected an earlier answer, give the corrected one.'
  );
}

export type AnswerSource = 'call' | 'sms' | 'manual';

export interface StoredAnswer {
  value: string | number | boolean;
  at: string;
  source: AnswerSource;
  /** The call or the last text the answer came from. */
  refId?: string;
}
export type StoredAnswers = Record<string, StoredAnswer>;

export function storedAnswers(raw: unknown): StoredAnswers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: StoredAnswers = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const a = v as Partial<StoredAnswer> | null;
    if (a && typeof a === 'object' && a.value != null && typeof a.at === 'string') out[k] = a as StoredAnswer;
  }
  return out;
}

/** A value checked against the question's type; null when it does not fit. */
export function coerceAnswer(q: Question, value: unknown): string | number | boolean | null {
  if (value == null) return null;
  switch (q.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[, ]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (/^(yes|true)$/i.test(String(value).trim())) return true;
      if (/^(no|false)$/i.test(String(value).trim())) return false;
      return null;
    case 'choice': {
      const s = String(value).trim().toLowerCase();
      return q.options?.find((o) => o.toLowerCase() === s) ?? null;
    }
    default: {
      const s = String(value).trim().slice(0, 500);
      return s || null;
    }
  }
}

/**
 * The lead's answers after a call or a text chat: each non-null answer
 * overwrites the stored one, unless the stored one is newer or a person
 * entered it (the AI never overrides an agent's edit).
 */
export function mergeAnswers(
  current: StoredAnswers,
  extracted: Record<string, unknown> | null | undefined,
  questions: Question[],
  at: Date,
  source: Exclude<AnswerSource, 'manual'>,
  refId?: string,
): { answers: StoredAnswers; changed: boolean } {
  const answers = { ...current };
  let changed = false;
  for (const q of customEnabled(questions)) {
    const value = coerceAnswer(q, extracted?.[q.key]);
    if (value == null) continue;
    const prev = answers[q.key];
    if (prev?.source === 'manual') continue;
    if (prev && new Date(prev.at).getTime() > at.getTime()) continue;
    if (prev && prev.value === value) continue;
    answers[q.key] = { value, at: at.toISOString(), source, ...(refId ? { refId } : {}) };
    changed = true;
  }
  return { answers, changed };
}

export interface LeadMemoryFields {
  timeline: string | null;
  location: string | null;
  minBudget: unknown;
  maxBudget: unknown;
  bedrooms: number | null;
  financingStatus: string | null;
  motivation: string | null;
  qualificationAnswers: unknown;
}

const money = (v: unknown) => Number(v).toLocaleString('en-US');

function builtinValue(key: BuiltinKey, lead: LeadMemoryFields): string | null {
  const text = (v: string | null) => v?.trim() || null;
  switch (key) {
    case 'timeline':
      return text(lead.timeline);
    case 'location':
      return text(lead.location);
    case 'budget': {
      const { minBudget: min, maxBudget: max } = lead;
      if (min != null && max != null) return Number(min) === Number(max) ? money(max) : `${money(min)} to ${money(max)}`;
      if (max != null) return `up to ${money(max)}`;
      if (min != null) return `from ${money(min)}`;
      return null;
    }
    case 'bedrooms':
      return lead.bedrooms != null ? String(lead.bedrooms) : null;
    case 'financing':
      return text(lead.financingStatus);
    case 'motivation':
      return text(lead.motivation);
  }
}

export interface QuestionStatus {
  question: Question;
  value: string | null;
  answer?: StoredAnswer;
}

/** Every enabled question with what the lead already told us, if anything. */
export function questionStatus(questions: Question[], lead: LeadMemoryFields): QuestionStatus[] {
  const answers = storedAnswers(lead.qualificationAnswers);
  return questions
    .filter((q) => q.enabled)
    .map((q) => {
      if (isBuiltin(q.key)) return { question: q, value: builtinValue(q.key, lead) };
      const answer = answers[q.key];
      const value = answer == null ? null : typeof answer.value === 'boolean' ? (answer.value ? 'Yes' : 'No') : String(answer.value);
      return { question: q, value, ...(answer ? { answer } : {}) };
    });
}

export const NOTHING_KNOWN = 'Nothing yet.';
export const NOTHING_TO_ASK = 'None — every qualification question is already answered.';

export interface MemoryVariables {
  knownInfo: string;
  questionsToAsk: string;
  /** The first open question, for a follow-up text template; empty when none is left. */
  nextQuestion: string;
}

/** The `knownInfo`, `questionsToAsk` and `nextQuestion` variables of a call, a text chat or a strategy text. */
export function memoryVariables(questions: Question[], lead: LeadMemoryFields | null): MemoryVariables {
  const status = lead ? questionStatus(questions, lead) : questions.filter((q) => q.enabled).map((question) => ({ question, value: null }));
  const known = status.filter((s) => s.value != null);
  const open = status.filter((s) => s.value == null);
  return {
    knownInfo: known.length ? known.map((s) => `- ${s.question.label}: ${s.value}`).join('\n') : NOTHING_KNOWN,
    questionsToAsk: open.length
      ? open
          .map((s, i) => {
            const opts = s.question.type === 'choice' && s.question.options?.length ? ` (${s.question.options.join(' / ')})` : '';
            return `${i + 1}. ${s.question.question}${opts}`;
          })
          .join('\n')
      : NOTHING_TO_ASK,
    nextQuestion: open[0]?.question.question ?? '',
  };
}

export const QUALIFICATION_PROMPT_START =
  '[EstatePulse: qualification questions — managed from Qualification questions in AI Settings; edit the questions there]';
export const QUALIFICATION_PROMPT_END = '[End of EstatePulse qualification questions]';

export function qualificationSection(): string {
  return [
    QUALIFICATION_PROMPT_START,
    '# What we already know about this lead',
    'From earlier calls and texts:',
    '{{knownInfo}}',
    'Other notes from earlier conversations: {{conversationSummary}}',
    'Never ask for any of these again. At most once, early on, confirm the key ones in a single short sentence (for example "I have your budget as around 500 thousand — is that still right?"). If the lead corrects something, accept the new answer and carry on.',
    '',
    '# Qualification questions still to ask',
    '{{questionsToAsk}}',
    'Ask only these, one at a time, in this order, and acknowledge each answer briefly. This list replaces any other list of qualification questions in these instructions. If the lead would rather not answer one, move on without pushing. When none are left, move on to booking a meeting or wrapping up.',
    QUALIFICATION_PROMPT_END,
  ].join('\n');
}

export function withoutQualificationSection(instructions: string): string {
  const start = instructions.indexOf(QUALIFICATION_PROMPT_START);
  if (start < 0) return instructions;
  const endAt = instructions.indexOf(QUALIFICATION_PROMPT_END, start);
  const end = endAt < 0 ? instructions.length : endAt + QUALIFICATION_PROMPT_END.length;
  const before = instructions.slice(0, start).replace(/\n{1,2}$/, '');
  const after = instructions.slice(end).replace(/^\n{1,2}/, '');
  return after ? `${before}\n\n${after}` : before;
}

/** The instructions with the managed section, replacing any earlier copy. */
export function withQualificationSection(instructions: string): string {
  const base = withoutQualificationSection(instructions ?? '').replace(/\s+$/, '');
  return base ? `${base}\n\n${qualificationSection()}` : qualificationSection();
}

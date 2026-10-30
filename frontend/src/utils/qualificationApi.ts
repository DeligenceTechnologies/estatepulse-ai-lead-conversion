import { apiFetch } from '../lib/api';

/**
 * The questions the AI asks this org's leads, and each lead's memory.
 *
 * Built-in questions (budget, timeline, ...) are answered by the lead's own
 * fields; custom questions are stored per lead. On every call and text chat
 * the assistant is told what is already known (to confirm, not re-ask), what
 * is still open, and a short note of everything else the lead said.
 */

export type QuestionType = 'text' | 'number' | 'boolean' | 'choice';

export interface Question {
  key: string;
  label: string;
  question: string;
  type: QuestionType;
  options?: string[];
  enabled: boolean;
  builtin: boolean;
}

export interface QuestionStatus {
  question: Question;
  value: string | null;
  answer?: { value: string | number | boolean; at: string; source: 'call' | 'sms' | 'manual'; refId?: string };
}

export interface LeadMemory {
  questions: QuestionStatus[];
  /** What the lead said that no question covers, rewritten after every call and chat. */
  summary: string | null;
  summaryAt: string | null;
}

export const getQuestions = () => apiFetch<{ questions: Question[] }>('/qualification-questions', { auth: true });

export const saveQuestions = (questions: Question[]) =>
  apiFetch<{ questions: Question[]; warning: string | null }>('/qualification-questions', {
    method: 'PUT',
    auth: true,
    body: { questions: questions.map(({ builtin: _b, ...q }) => q) },
  });

export const getLeadMemory = (leadId: string) => apiFetch<LeadMemory>(`/leads/${leadId}/memory`, { auth: true });

export const setLeadAnswer = (leadId: string, key: string, value: string | number | boolean | null) =>
  apiFetch<LeadMemory>(`/leads/${leadId}/memory/${encodeURIComponent(key)}`, {
    method: 'PUT',
    auth: true,
    body: { value },
  });

/** A key from a label: "Property type" -> "property_type". */
export function keyFor(label: string, taken: string[]): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'question').replace(/^(\d)/, 'q_$1').slice(0, 36);
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base}_${i}`;
  return key;
}

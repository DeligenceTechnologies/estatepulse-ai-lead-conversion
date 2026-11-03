import { apiFetch } from '../lib/api';
import type { ContactLimits, StepConditions, StepVoicemail } from './journey';

export interface StrategyStep {
  id: string;
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
  /** When the step runs at all; unset, always. */
  onlyIf?: StepConditions;
  /** A call step: what it leaves on an answering machine. Unset is the AI Settings voicemail setting. */
  voicemail?: StepVoicemail;
  /** A call step: why the AI is calling, given to it as {{call_context}}. */
  context?: string;
}
/**
 * When contacting a lead is allowed, and the limits on how hard we try.
 *
 * Deliberately org-wide rather than per-sequence: the strategy engine and the
 * nurture runner both read this one object, so an office that sets its contact
 * hours once cannot discover that one of the two schedulers ignored them.
 */
export interface Guardrails {
  respectQuietHours?: boolean;
  /** 'HH:MM', 24-hour, in the organization's timezone. Quiet = do NOT contact. */
  quietHours?: { start: string; end: string };
  maxVoiceAttempts?: number;
  stopOn?: string[];
  /** Per lead, per day, shared by the strategy, every sequence and callbacks' count. */
  limits?: ContactLimits;
  /** Days of the week (0 = Sunday) nobody is contacted. */
  skipDays?: number[];
}

export interface Strategy {
  name: string;
  guardrails?: Guardrails;
  steps: StrategyStep[];
}

export const getStrategy = () =>
  apiFetch<{ strategy: Strategy }>('/strategy', { auth: true }).then((d) => d.strategy);

export const saveStrategy = (strategy: Partial<Strategy>) =>
  apiFetch<{ strategy: Strategy }>('/strategy', { method: 'PUT', body: strategy, auth: true }).then((d) => d.strategy);

export function emptyStep(): StrategyStep {
  return { id: `s${Math.random().toString(36).slice(2, 7)}`, after: { value: 5, unit: 'minutes' }, channel: 'sms', action: 'send_sms', message: '' };
}

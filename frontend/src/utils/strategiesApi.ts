import { apiFetch } from '../lib/api';
import { ALWAYS, onlyIfText, presetOf, type OnlyIf } from './conditions';

export interface StrategyStep {
  id: string;
  /** Step 1: after the lead comes in. Step 2: after step 1 (a call: after it ends; a text: after it is sent). */
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
  /** Step 2's "Only if". */
  onlyIf?: OnlyIf;
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
  /** Older saved strategies carry it; nothing reads it. */
  stopOn?: string[];
}

export interface Strategy {
  name: string;
  guardrails?: Guardrails;
  steps: StrategyStep[];
  /** 'after_previous' once saved by the two-step editor. */
  timing?: 'after_previous';
}

/** A built-in rule the engine always applies, from the server's one list. */
export interface SafetyRule {
  id: string;
  label: string;
  kind: 'never_sends' | 'waits';
  appliesTo: ('strategy' | 'sequence')[];
}

/** The strategy in the two-step editor's form. `converted`: what it shows differs from what is saved and running. */
export interface StrategyEditorView {
  steps: StrategyStep[];
  converted: boolean;
}

export interface StrategyEditorPayload {
  strategy: Strategy;
  editor: StrategyEditorView;
  safetyRules: SafetyRule[];
}

export const getStrategy = () =>
  apiFetch<{ strategy: Strategy }>('/strategy', { auth: true }).then((d) => d.strategy);

export const saveStrategy = (strategy: Partial<Strategy>) =>
  apiFetch<{ strategy: Strategy }>('/strategy', { method: 'PUT', body: strategy, auth: true }).then((d) => d.strategy);

export const getStrategyEditor = () => apiFetch<StrategyEditorPayload>('/strategy', { auth: true });

export const saveStrategySteps = (steps: StrategyStep[]) =>
  apiFetch<StrategyEditorPayload>('/strategy', { method: 'PUT', body: { steps }, auth: true });

export const channelLabel = (channel: StrategyStep['channel']) => (channel === 'voice' ? 'AI Voice Call' : 'SMS');

const UNIT_MS: Record<StrategyStep['after']['unit'], number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const afterMs = (after: StrategyStep['after']) => (Number(after.value) || 0) * UNIT_MS[after.unit];

/** "5 min", "1 hour", "2 days" */
export function waitText(after: StrategyStep['after']): string {
  const n = Number(after.value) || 0;
  const unit = { seconds: 'sec', minutes: 'min', hours: n === 1 ? 'hour' : 'hours', days: n === 1 ? 'day' : 'days' }[after.unit];
  return `${n} ${unit}`;
}

/** Call ⇄ SMS: step 2 becomes step 1 (keeping its start time), the old step 1 waits step 2's time after it; the condition starts over (other fields apply). */
export function swapOrder([first, second]: StrategyStep[]): StrategyStep[] {
  return [
    { ...second, after: first.after, onlyIf: undefined },
    { ...first, after: second.after, onlyIf: ALWAYS },
  ];
}

/** An office without SMS (a calling provider that has none) calls first; the text card shows as unavailable. */
export const callFirst = (steps: StrategyStep[]): StrategyStep[] => (steps[0]?.channel === 'sms' ? swapOrder(steps) : steps);

/** The same rules the server applies, so a mistake shows before Save. */
export function stepsError(steps: StrategyStep[]): string | null {
  const sms = steps.find((s) => s.channel === 'sms');
  if (sms && !(sms.message ?? '').trim()) return 'The SMS step needs a message.';
  const start = afterMs(steps[0]?.after ?? { value: 0, unit: 'minutes' });
  if (start < 0 || start > 12 * 3_600_000) return 'Step 1 can start at most 12 hours after the lead comes in.';
  if (!Number.isFinite(steps[1]?.after.value) || (steps[1]?.after.value ?? 0) < 0) return 'Step 2 needs a wait of zero or more.';
  return null;
}

/** The plain-English line under a step card, updated as the owner edits it. */
export function stepSummary(steps: StrategyStep[], index: number): string {
  const step = steps[index];
  if (!step) return '';
  const noun = step.channel === 'voice' ? 'call' : 'SMS';
  if (index === 0) {
    const when = afterMs(step.after) > 0 ? `${waitText(step.after)} after the lead comes in` : 'as soon as the lead comes in';
    return `This ${noun} goes ${when}, within contact hours.`;
  }
  const from = steps[index - 1].channel === 'voice' ? 'the call ends' : 'the SMS is sent';
  const preset = presetOf(step.onlyIf, steps[index - 1].channel === 'voice' ? 'after_call' : 'after_sms');
  const condition = preset ? (preset.value === 'always' ? '' : preset.label.charAt(0).toLowerCase() + preset.label.slice(1)) : onlyIfText(step.onlyIf);
  return `This ${noun} goes ${waitText(step.after)} after ${from}${condition ? `, ${condition}` : ''}.`;
}

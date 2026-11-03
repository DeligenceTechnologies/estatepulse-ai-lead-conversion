import { CallDisposition, CallStatus } from '@prisma/client';
import type { StrategyStep } from './strategy-store.service';

export type FlowState = 'done' | 'failed' | 'current' | 'pending' | 'skipped';

export interface FlowStep {
  index: number;
  channel: string;
  action: string;
  after: StrategyStep['after'];
  state: FlowState;
  /** A word or two for the chip: SMS sent, No answer, Skipped, Waiting… */
  outcome: string | null;
  /** Why it was skipped or is waiting, as the step log has it. */
  detail: string | null;
}

export interface StepLogEntry {
  type: string;
  reason: string | null;
  payload: unknown;
  createdAt?: Date;
}

export interface FlowCall {
  status: CallStatus;
  disposition: CallDisposition | null;
  createdAt?: Date;
}

const CALL_LABELS: Partial<Record<CallDisposition, string>> = {
  [CallDisposition.connected]: 'Answered',
  [CallDisposition.no_answer]: 'No answer',
  [CallDisposition.voicemail]: 'Voicemail',
  [CallDisposition.busy]: 'Busy',
  [CallDisposition.rejected]: 'Declined',
  [CallDisposition.short]: 'Hung up',
  [CallDisposition.failed]: 'Call failed',
  [CallDisposition.invalid_number]: 'Invalid number',
};

function callOutcome(call: FlowCall | undefined): { state: FlowState; outcome: string } {
  if (!call || call.status === CallStatus.queued) return { state: 'current', outcome: 'Call queued' };
  if (call.status === CallStatus.ringing) return { state: 'current', outcome: 'Ringing' };
  if (call.status === CallStatus.in_progress) return { state: 'current', outcome: 'On the call' };
  const label = (call.disposition && CALL_LABELS[call.disposition]) ?? (call.status === CallStatus.completed ? 'Answered' : 'No answer');
  return { state: call.disposition === CallDisposition.connected || (!call.disposition && call.status === CallStatus.completed) ? 'done' : 'failed', outcome: label };
}

const stepIdOf = (entry: StepLogEntry) => (entry.payload as { stepId?: unknown } | null)?.stepId;

/**
 * Each strategy step as the step log has it: sent (a call with how it went),
 * skipped with why, failed, waiting, or still to come. Null for a lead from
 * before the step log, which is matched against its calls and texts instead.
 * A call step's call is the first one placed after the step went (a callback
 * or a manual call in between is someone else's); without times, the next one.
 */
export function flowFromLog(steps: StrategyStep[], log: StepLogEntry[], calls: FlowCall[]): FlowStep[] | null {
  if (!log.some((entry) => typeof stepIdOf(entry) === 'string')) return null;
  const used = new Set<number>();
  const callAfter = (sentAt: Date | undefined): FlowCall | undefined => {
    const i = calls.findIndex((c, k) => !used.has(k) && (!sentAt || !c.createdAt || c.createdAt >= sentAt));
    if (i < 0) return undefined;
    used.add(i);
    return calls[i];
  };
  const latest = new Map<string, StepLogEntry>();
  const order: string[] = [];
  for (const entry of log) {
    const id = stepIdOf(entry);
    if (typeof id !== 'string') continue;
    const before = latest.get(id);
    // A hold is only news while nothing decisive is on record for the step.
    if (before && before.type !== 'step_held' && entry.type === 'step_held') continue;
    latest.set(id, entry);
    if (!order.includes(id)) order.push(id);
  }
  // Calls go to the sent call steps in the order those were sent.
  const callFor = new Map<string, FlowCall | undefined>();
  for (const id of order) {
    const step = steps.find((s) => s.id === id);
    const entry = latest.get(id);
    if (step?.channel === 'voice' && entry?.type === 'step_sent') callFor.set(id, callAfter(entry.createdAt));
  }

  const out = steps.map((s, index): FlowStep => {
    const base = { index, channel: s.channel, action: s.action ?? s.channel, after: s.after };
    const entry = latest.get(s.id);
    if (!entry) return { ...base, state: 'pending', outcome: null, detail: null };
    if (entry.type === 'step_skipped') return { ...base, state: 'skipped', outcome: 'Skipped', detail: entry.reason };
    if (entry.type === 'step_failed') return { ...base, state: 'failed', outcome: s.channel === 'voice' ? 'Call failed' : 'SMS failed', detail: entry.reason };
    if (entry.type === 'step_held') return { ...base, state: 'current', outcome: 'Waiting', detail: entry.reason };
    if (s.channel === 'voice') return { ...base, ...callOutcome(callFor.get(s.id)), detail: null };
    return { ...base, state: 'done', outcome: 'SMS sent', detail: null };
  });
  const next = out.findIndex((s) => s.state === 'pending');
  if (next >= 0 && !out.some((s) => s.state === 'current')) out[next].state = 'current';
  return out;
}

import { CALL_ROW_LEEWAY_MS, callResult, type SkipReason } from './step-guard.service';
import type { StrategyStep } from '@/telnyx/strategy-store.service';

/** What a skipped step shows on the lead. */
export const SKIP_LABELS: Record<SkipReason, string> = {
  booked: 'Skipped — meeting booked',
  call_answered: 'Skipped — the call was answered',
  max_voice_attempts: 'Skipped — call limit reached',
  call_unresolved: 'Skipped — the call had not finished',
  call_still_queued: 'Skipped — the call never left the queue',
  condition_not_met: 'Skipped — its condition did not hold',
  safety_rule: 'Skipped — a safety rule stopped it',
};

type FlowCall = Parameters<typeof callResult>[0];

interface FlowRun {
  stepNumber: number;
  outcome: string;
  reason: string | null;
  detail?: string | null;
  createdAt: Date;
}

/** Each strategy step as the step runs on record tell it: sent, failed, skipped and why, or how its call went. */
export function strategyFlowSteps(steps: StrategyStep[], runs: FlowRun[], calls: FlowCall[]) {
  return steps.map((s, index) => {
    const base = { index, channel: s.channel, action: s.action ?? s.channel, after: s.after };
    const run = runs.find((r) => r.stepNumber === index + 1);
    if (!run) return { ...base, state: 'pending', outcome: null as string | null };
    if (run.outcome === 'skipped') {
      return { ...base, state: 'skipped', outcome: run.detail ? `Skipped — ${run.detail}` : (SKIP_LABELS[run.reason as SkipReason] ?? 'Skipped') };
    }
    if (run.outcome === 'failed') return { ...base, state: 'failed', outcome: s.channel === 'voice' ? 'Call failed' : 'SMS failed' };
    if (s.channel === 'sms') return { ...base, state: 'done', outcome: 'SMS sent' };
    return { ...base, ...callStep(calls.find((c) => c.createdAt.getTime() >= run.createdAt.getTime() - CALL_ROW_LEEWAY_MS)) };
  });
}

function callStep(call: FlowCall | undefined): { state: string; outcome: string } {
  if (!call) return { state: 'current', outcome: 'Call queued' };
  switch (callResult(call)) {
    case 'live':
      return { state: 'current', outcome: call.status === 'in_progress' ? 'On the call' : 'Ringing' };
    case 'awaiting_analysis':
      return { state: 'current', outcome: 'Checking how the call went' };
    case 'answered':
      return { state: 'done', outcome: 'Answered' };
    case 'failed':
      return { state: 'failed', outcome: 'Call failed' };
    default:
      return { state: 'failed', outcome: call.status === 'completed' ? 'Short call or voicemail' : 'No answer' };
  }
}

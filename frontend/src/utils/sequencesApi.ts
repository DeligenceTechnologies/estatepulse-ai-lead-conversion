import { apiFetch } from '../lib/api';

/**
 * Nurture sequences: authoring them, and putting leads into them.
 *
 * Reads need a session; every write is owner-only server-side. The UI hides
 * the controls from an agent as a courtesy — the 403 is the actual boundary,
 * exactly as in agentsApi.
 */

/** The two values sequence_steps_action_check allows. 'call' is not one. */
export type ActionType = 'sms' | 'voice';

/** followup_sequences_status_check. */
export type SequenceStatus = 'active' | 'inactive' | 'archived';

export type Temperature = 'hot' | 'warm' | 'cold';

/**
 * What has to happen to a lead for it to be enrolled automatically. Mirrors
 * enrollTriggerSchema on the server, which in turn mirrors the CHECK
 * constraint — all three lists have to agree or a condition silently never
 * fires.
 */
export type EnrollTrigger =
  | 'qualified_hot'
  | 'qualified_warm'
  | 'qualified_cold'
  | 'call_failed'
  | 'no_answer'
  | 'answered_not_qualified'
  | 'no_reply'
  | 'strategy_completed';

/**
 * The tick boxes, in the order a person thinks about them: what the call
 * concluded first, then the ways it can come to nothing.
 *
 * Grouped so the editor can show the two halves under their own headings —
 * qualification is something the lead did, everything else is something that
 * failed to happen.
 */
export const ENROLL_TRIGGERS: Array<{
  value: EnrollTrigger;
  group: 'qualified' | 'negative';
  label: string;
  hint: string;
  /** Shown as a pill on the card. Only the temperatures carry one — the
   *  negative conditions have no established colour and inventing one would
   *  imply a severity ranking that does not exist. */
  badge?: { text: string; className: string };
}> = [
  { value: 'qualified_hot', group: 'qualified', label: 'Qualified as hot',
    hint: 'The AI spoke to them and they are ready to move.',
    badge: { text: 'HOT', className: 'bg-rose-500/15 text-rose-400 border-rose-500/30' } },
  { value: 'qualified_warm', group: 'qualified', label: 'Qualified as warm',
    hint: 'Interested, but not yet.',
    badge: { text: 'WARM', className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' } },
  { value: 'qualified_cold', group: 'qualified', label: 'Qualified as cold',
    hint: 'Spoke to them, no real intent right now.',
    badge: { text: 'COLD', className: 'bg-sky-500/15 text-sky-400 border-sky-500/30' } },
  { value: 'call_failed', group: 'negative', label: 'Every call failed to connect',
    hint: 'The number never even rang — usually a bad number.' },
  { value: 'no_answer', group: 'negative', label: 'Nobody ever answered',
    hint: 'It rang every time and nobody picked up.' },
  { value: 'answered_not_qualified', group: 'negative', label: 'Answered, but never qualified',
    hint: 'They picked up, but the call never reached a conclusion.' },
  { value: 'no_reply', group: 'negative', label: 'Never replied to anything',
    hint: 'No answered call and no reply to any text.' },
  { value: 'strategy_completed', group: 'negative', label: 'Finished the strategy without qualifying',
    hint: 'The catch-all: every step ran and nothing came of it.' },
];

export interface SequenceStep {
  stepOrder: number;
  actionType: ActionType;
  /** Gap before this step, measured from the PREVIOUS step — not from enrolment. */
  delayMinutes: number;
  messageTemplate: string | null;
  voicePrompt: string | null;
  maxAttempts: number;
}

/** What the editor sends. `stepOrder` is absent: the server uses array order. */
export interface StepDraft {
  actionType: ActionType;
  delayMinutes: number;
  messageTemplate?: string | null;
  voicePrompt?: string | null;
  maxAttempts?: number;
}

export interface Sequence {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: SequenceStatus;
  /** Which temperature auto-enrols here. Null means manual only. */
  enrollTriggers: EnrollTrigger[];
  activeCount: number;
  pausedCount: number;
  completedCount: number;
  stoppedCount: number;
  createdAt: string;
  steps: SequenceStep[];
}

export interface Enrollment {
  id: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  temperature: string | null;
  sequenceCode: string | null;
  sequenceName: string | null;
  currentStep: number;
  status: string;
  nextActionAt: string | null;
  enrolledAt: string;
  stoppedReason: string | null;
  lastError: string | null;
  /** 'auto' | 'manual' | 'bulk' — how this lead got here. */
  enrolledBy: string;
}

/** The bulk conditions. Every field narrows; an empty filter matches everyone. */
export interface LeadFilter {
  temperature?: Temperature;
  status?: string;
  sourceId?: string;
  createdFrom?: string;
  createdTo?: string;
  /** Never replied to anything. */
  noReply?: boolean;
  /** Never contacted at all. */
  neverContacted?: boolean;
  q?: string;
}

export interface FilterPreview {
  total: number;
  /** The most one call may enrol. A larger match is added in batches. */
  cap: number;
  sample: {
    id: string;
    name: string;
    phone: string | null;
    temperature: string | null;
    status: string;
  }[];
}

export interface EnrollResult {
  matched: number;
  enrolled: number;
  skipped: {
    leadId: string;
    leadName: string;
    /** 'in_strategy' — the strategy engine is still contacting them. */
    reason: 'dnc' | 'already_enrolled' | 'not_found' | 'in_strategy';
  }[];
  dryRun: boolean;
}

export const listSequences = (): Promise<Sequence[]> =>
  apiFetch<Sequence[]>('/v1/sequences', { auth: true });

export const listEnrollments = (limit?: number): Promise<Enrollment[]> =>
  apiFetch<Enrollment[]>(`/v1/sequences/enrollments${limit ? `?limit=${limit}` : ''}`, {
    auth: true,
  });

/**
 * Turn a step gap into the cumulative day it lands on, which is how the spec
 * states the cadence and how a human reads a drip. Steps must be in order.
 */
export const cumulativeDays = (steps: SequenceStep[]): number[] => {
  let running = 0;
  return steps.map((s) => {
    running += s.delayMinutes;
    return Math.round((running / 1440) * 10) / 10;
  });
};

/** "2 days", "4 hours", "30 minutes" — the gap, not the position. */
export const formatDelay = (minutes: number): string => {
  if (minutes >= 1440) {
    const d = Math.round((minutes / 1440) * 10) / 10;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (minutes >= 60) {
    const h = Math.round((minutes / 60) * 10) / 10;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${minutes} min`;
};

// ------------------------------------------------------------------- authoring

/** Condition -> its wording, derived so the two can never disagree. */
export const TRIGGER_LABELS: Record<string, string> = Object.fromEntries(
  ENROLL_TRIGGERS.map((t) => [t.value, t.label]),
);

export const createSequence = (body: {
  name: string;
  code: string;
  description?: string;
  status?: SequenceStatus;
  enrollTriggers?: EnrollTrigger[];
  steps: StepDraft[];
}): Promise<Sequence> =>
  apiFetch<Sequence>('/v1/sequences', { method: 'POST', body, auth: true });

export const updateSequence = (
  id: string,
  body: {
    name?: string;
    description?: string | null;
    status?: SequenceStatus;
    enrollTriggers?: EnrollTrigger[];
  },
): Promise<Sequence> =>
  apiFetch<Sequence>(`/v1/sequences/${id}`, { method: 'PATCH', body, auth: true });

/** Replaces every step. The editor owns the whole list, so PUT rather than PATCH. */
export const replaceSteps = (id: string, steps: StepDraft[]): Promise<Sequence> =>
  apiFetch<Sequence>(`/v1/sequences/${id}/steps`, { method: 'PUT', body: { steps }, auth: true });

/** Archives rather than deletes — the enrolment history is the point. */
export const archiveSequence = (id: string): Promise<{ archived: true; stoppedEnrollments: number }> =>
  apiFetch(`/v1/sequences/${id}`, { method: 'DELETE', auth: true });

// ------------------------------------------------------------------ enrolment

/** How many leads a set of conditions matches, before anybody commits to texting them. */
export const previewFilter = (filter: LeadFilter): Promise<FilterPreview> =>
  apiFetch<FilterPreview>('/v1/sequences/preview', { method: 'POST', body: filter, auth: true });

export const enrollLeads = (
  sequenceId: string,
  body: { leadIds: string[] } | { filter: LeadFilter },
  dryRun = false,
): Promise<EnrollResult> =>
  apiFetch<EnrollResult>(`/v1/sequences/${sequenceId}/enroll`, {
    method: 'POST',
    body: { ...body, dryRun },
    auth: true,
  });

export const stopEnrollment = (enrollmentId: string): Promise<{ stopped: true }> =>
  apiFetch(`/v1/sequences/enrollments/${enrollmentId}/stop`, { method: 'POST', auth: true });

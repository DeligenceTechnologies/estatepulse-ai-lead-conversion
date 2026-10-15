import type { FollowUpReason, LeadStatus } from '../types';

/**
 * The 9 lead statuses in lifecycle order — the backend's LeadStatus
 * (backend/src/common/domain.ts) and leads_status_check. One list, so the
 * dashboard bars, the table badges and every filter agree.
 */
export const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'contacting',
  'follow_up',
  'interested',
  'appointment_requested',
  'appointment_booked',
  'not_interested',
  'closed',
  'invalid',
];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacting: 'Contacting',
  follow_up: 'Follow-up',
  interested: 'Interested',
  appointment_requested: 'Appointment requested',
  appointment_booked: 'Appointment booked',
  not_interested: 'Not interested',
  closed: 'Closed',
  invalid: 'Invalid',
};

/** Badge colours, in the palette the table already used. */
export const STATUS_TONES: Record<LeadStatus, string> = {
  new: 'bg-slate-800 text-slate-300 border border-slate-700',
  contacting: 'bg-sky-950 text-sky-300 border border-sky-800/40',
  follow_up: 'bg-orange-950 text-orange-300 border border-orange-800/40',
  interested: 'bg-emerald-950 text-emerald-300 border border-emerald-800/40',
  appointment_requested: 'bg-violet-950 text-violet-300 border border-violet-800/40',
  appointment_booked: 'bg-purple-950 text-purple-300 border border-purple-800/40',
  not_interested: 'bg-rose-950 text-rose-300 border border-rose-800/40',
  closed: 'bg-slate-900 text-slate-400 border border-slate-700',
  invalid: 'bg-zinc-900 text-zinc-400 border border-zinc-700',
};

/** leads.follow_up_reason — the backend's FollowUpReason. */
export const FOLLOW_UP_REASON_LABELS: Record<FollowUpReason, string> = {
  no_answer: 'No answer',
  not_ready: 'Not ready',
  callback_requested: 'Callback requested',
  needs_time: 'Needs time',
  other: 'Other',
};

/** Retired spellings, read the way the backend's normalizeLeadStatus reads them. */
const LEGACY: Record<string, LeadStatus> = {
  booked: 'appointment_booked',
  lost: 'not_interested',
  dnc: 'not_interested',
  contacted: 'contacting',
  engaged: 'contacting',
  qualified: 'interested',
  nurture: 'follow_up',
};

/**
 * Any status string as one of the 9. The API already normalizes, so this only
 * matters for a stale cached row.
 */
export function normalizeStatus(status: string | null | undefined): LeadStatus {
  const s = status ?? '';
  if (LEGACY[s]) return LEGACY[s];
  return (LEAD_STATUSES as readonly string[]).includes(s) ? (s as LeadStatus) : 'new';
}

export const statusLabel = (status: string | null | undefined): string => STATUS_LABELS[normalizeStatus(status)];
export const statusTone = (status: string | null | undefined): string => STATUS_TONES[normalizeStatus(status)];

/** The reason label for a follow_up lead; null for any other status. */
export function followUpReasonLabel(status: string | null | undefined, reason: string | null | undefined): string | null {
  if (normalizeStatus(status) !== 'follow_up') return null;
  return FOLLOW_UP_REASON_LABELS[reason as FollowUpReason] ?? null;
}

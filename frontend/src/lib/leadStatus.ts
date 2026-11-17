import type { FollowUpReason, LeadStatus } from '../types';

/**
 * The 11 lead statuses in lifecycle order — the backend's LeadStatus enum
 * (backend/prisma/schema/enums.prisma). One list, so the dashboard bars, the
 * table badges and every filter agree.
 */
export const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'contacting',
  'engaged',
  'follow_up',
  'interested',
  'appointment_requested',
  'appointment_booked',
  'not_interested',
  'unresponsive',
  'closed',
  'invalid',
];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacting: 'Contacting',
  engaged: 'Engaged',
  follow_up: 'Follow-up',
  interested: 'Interested',
  appointment_requested: 'Appointment requested',
  appointment_booked: 'Appointment booked',
  not_interested: 'Not interested',
  unresponsive: 'Unresponsive',
  closed: 'Closed',
  invalid: 'Invalid',
};

/**
 * Badge colours: a soft tint, a hairline border and readable text of one hue,
 * so a badge reads the same on the dark and the light theme. Hues follow the
 * journey: blues while reaching out, amber when waiting, green when keen,
 * violet once an appointment is in play, rose for a no, greys when it is over.
 * Green, not emerald, for "Interested": emerald is the brand colour and moves
 * with Settings → Appearance.
 */
export const STATUS_TONES: Record<LeadStatus, string> = {
  new: 'bg-blue-500/10 text-blue-300 border border-blue-500/25',
  contacting: 'bg-sky-500/10 text-sky-300 border border-sky-500/25',
  engaged: 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/25',
  follow_up: 'bg-amber-500/10 text-amber-300 border border-amber-500/25',
  interested: 'bg-green-500/10 text-green-300 border border-green-500/25',
  appointment_requested: 'bg-violet-500/10 text-violet-300 border border-violet-500/25',
  appointment_booked: 'bg-purple-500/15 text-purple-300 border border-purple-500/30',
  not_interested: 'bg-rose-500/10 text-rose-300 border border-rose-500/25',
  unresponsive: 'bg-stone-500/10 text-stone-400 border border-stone-500/25',
  closed: 'bg-slate-500/10 text-slate-300 border border-slate-500/25',
  invalid: 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/25',
};

/** The small dot at the start of a status badge, in the badge's hue. */
export const STATUS_DOTS: Record<LeadStatus, string> = {
  new: 'bg-blue-400',
  contacting: 'bg-sky-400',
  engaged: 'bg-cyan-400',
  follow_up: 'bg-amber-400',
  interested: 'bg-green-400',
  appointment_requested: 'bg-violet-400',
  appointment_booked: 'bg-purple-400',
  not_interested: 'bg-rose-400',
  unresponsive: 'bg-stone-400',
  closed: 'bg-slate-400',
  invalid: 'bg-zinc-400',
};

/** leads.follow_up_reason — the backend's FollowUpReason. */
export const FOLLOW_UP_REASON_LABELS: Record<FollowUpReason, string> = {
  no_answer: 'No answer',
  not_ready: 'Not ready',
  callback_requested: 'Callback requested',
  needs_time: 'Needs time',
  other: 'Other',
  appointment_canceled: 'Appointment canceled',
  no_show: 'No-show',
};

/** Retired spellings, read the way the backend's normalizeLeadStatus reads them. */
const LEGACY: Record<string, LeadStatus> = {
  booked: 'appointment_booked',
  lost: 'not_interested',
  dnc: 'not_interested',
  contacted: 'contacting',
  qualified: 'interested',
  nurture: 'follow_up',
};

/**
 * Any status string as one of the 11. The API already normalizes, so this only
 * matters for a stale cached row.
 */
export function normalizeStatus(status: string | null | undefined): LeadStatus {
  const s = status ?? '';
  if (LEGACY[s]) return LEGACY[s];
  return (LEAD_STATUSES as readonly string[]).includes(s) ? (s as LeadStatus) : 'new';
}

export const statusLabel = (status: string | null | undefined): string => STATUS_LABELS[normalizeStatus(status)];
export const statusTone = (status: string | null | undefined): string => STATUS_TONES[normalizeStatus(status)];
export const statusDot = (status: string | null | undefined): string => STATUS_DOTS[normalizeStatus(status)];

/** The reason label for a follow_up lead; null for any other status. */
export function followUpReasonLabel(status: string | null | undefined, reason: string | null | undefined): string | null {
  if (normalizeStatus(status) !== 'follow_up') return null;
  return FOLLOW_UP_REASON_LABELS[reason as FollowUpReason] ?? null;
}

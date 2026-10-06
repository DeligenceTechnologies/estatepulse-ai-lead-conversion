import type { LeadStatus } from '../types';

/**
 * The 13 lead statuses in lifecycle order — the backend's LeadStatus
 * (backend/src/common/domain.ts) and leads_status_check. One list, so the
 * dashboard bars, the table badges and every filter agree.
 */
export const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'contacting',
  'contacted',
  'engaged',
  'qualified',
  'appointment_requested',
  'appointment_booked',
  'follow_up',
  'nurture',
  'not_interested',
  'dnc',
  'invalid',
  'closed',
];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacting: 'Contacting',
  contacted: 'Contacted',
  engaged: 'Engaged',
  qualified: 'Qualified',
  appointment_requested: 'Appointment requested',
  appointment_booked: 'Appointment booked',
  follow_up: 'Follow-up',
  nurture: 'Nurture',
  not_interested: 'Not interested',
  dnc: 'Do not contact',
  invalid: 'Invalid',
  closed: 'Closed',
};

/** Badge colours, in the palette the table already used. */
export const STATUS_TONES: Record<LeadStatus, string> = {
  new: 'bg-slate-800 text-slate-300 border border-slate-700',
  contacting: 'bg-sky-950 text-sky-300 border border-sky-800/40',
  contacted: 'bg-cyan-950 text-cyan-300 border border-cyan-800/40',
  engaged: 'bg-teal-950 text-teal-300 border border-teal-800/40',
  qualified: 'bg-emerald-950 text-emerald-300 border border-emerald-800/40',
  appointment_requested: 'bg-violet-950 text-violet-300 border border-violet-800/40',
  appointment_booked: 'bg-purple-950 text-purple-300 border border-purple-800/40',
  follow_up: 'bg-orange-950 text-orange-300 border border-orange-800/40',
  nurture: 'bg-amber-950 text-amber-300 border border-amber-800/40',
  not_interested: 'bg-rose-950 text-rose-300 border border-rose-800/40',
  dnc: 'bg-red-950 text-red-300 border border-red-800/40',
  invalid: 'bg-zinc-900 text-zinc-400 border border-zinc-700',
  closed: 'bg-slate-900 text-slate-400 border border-slate-700',
};

/**
 * Any status string as one of the 13. The API already normalizes, so this only
 * matters for a stale cached row: legacy 'booked' and 'lost' map the way the
 * backend's normalizeLeadStatus does.
 */
export function normalizeStatus(status: string | null | undefined, dnc = false): LeadStatus {
  if (status === 'booked') return 'appointment_booked';
  if (status === 'lost') return dnc ? 'dnc' : 'not_interested';
  return (LEAD_STATUSES as readonly string[]).includes(status ?? '') ? (status as LeadStatus) : 'new';
}

export const statusLabel = (status: string | null | undefined): string => STATUS_LABELS[normalizeStatus(status)];
export const statusTone = (status: string | null | undefined): string => STATUS_TONES[normalizeStatus(status)];

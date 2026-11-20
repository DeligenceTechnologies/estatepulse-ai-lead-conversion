import { apiFetch } from '../lib/api';

/**
 * Duplicate leads: the review queue of leads that look like the same person, merging them (with
 * undo), and the sources a lead came from. A phone or email that is already a lead's never makes a
 * second lead — those are attached on arrival; this is for the rest (old duplicates, near matches).
 */

export interface DuplicateLeadSummary {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  temperature: string | null;
  location: string | null;
  timeline: string | null;
  minBudget: number | null;
  maxBudget: number | null;
  dncStatus: boolean;
  consentStatus: string;
  submissionCount: number;
  createdAt: string;
  lastContactAt: string | null;
  source: { id: string; name: string; provider: string } | null;
  assignedAgent: { id: string; name: string } | null;
  activity: { calls: number; messages: number; meetings: number };
}

export type DuplicateStatus = 'open' | 'merged' | 'dismissed';

export interface DuplicatePair {
  id: string;
  score: number;
  reasons: string[];
  status: DuplicateStatus;
  createdAt: string;
  resolvedAt: string | null;
  leadA: DuplicateLeadSummary;
  leadB: DuplicateLeadSummary;
  /** The lead to keep by default: furthest along, then most talked to, then the older. */
  suggestedSurvivorId: string;
  /** Compared fields whose values differ between the two. */
  differences: string[];
}

export interface LeadDuplicate {
  id: string;
  score: number;
  reasons: string[];
  other: DuplicateLeadSummary;
}

export interface LeadSubmission {
  id: string;
  channel: 'webhook' | 'manual' | 'import' | 'crm' | 'sms' | 'backfill';
  isOriginal: boolean;
  matchedBy: 'phone' | 'email' | null;
  submittedAt: string;
  source: { id: string; name: string; provider: string } | null;
  values: Record<string, unknown>;
}

export interface LeadMergeEntry {
  id: string;
  mergedLead: { id: string; name: string; phone: string | null; email: string | null } | null;
  reasons: string[];
  createdAt: string;
  undoneAt: string | null;
  canUndo: boolean;
  moved: { messages: number; calls: number; meetings: number };
}

export interface MergeResult {
  mergeId: string;
  survivorId: string;
  mergedId: string;
}

export const listDuplicates = (status: DuplicateStatus = 'open', take = 25, skip = 0) =>
  apiFetch<{ total: number; items: DuplicatePair[] }>(`/v1/duplicates?status=${status}&take=${take}&skip=${skip}`, { auth: true });

/** Open suggestions; 0 when it cannot be read (no permission, server unreachable). */
export const duplicateCount = (): Promise<number> =>
  apiFetch<{ open: number }>('/v1/duplicates/count', { auth: true }).then((r) => r.open, () => 0);

export const scanDuplicates = () =>
  apiFetch<{ open: number; added: number; dropped: number }>('/v1/duplicates/scan', { method: 'POST', auth: true });

export const dismissDuplicate = (id: string) => apiFetch<{ dismissed: true }>(`/v1/duplicates/${id}/dismiss`, { method: 'POST', auth: true });

/** Merges the pair, keeping `survivorId`; the other lead's history moves to it. */
export const mergeDuplicate = (id: string, survivorId: string) =>
  apiFetch<MergeResult>(`/v1/duplicates/${id}/merge`, { method: 'POST', auth: true, body: { survivorId } });

export const leadDuplicates = (leadId: string) => apiFetch<LeadDuplicate[]>(`/v1/leads/${leadId}/duplicates`, { auth: true });

export const leadSubmissions = (leadId: string) => apiFetch<LeadSubmission[]>(`/v1/leads/${leadId}/submissions`, { auth: true });

export const leadMerges = (leadId: string) => apiFetch<LeadMergeEntry[]>(`/v1/leads/${leadId}/merges`, { auth: true });

/** Merges `mergeLeadId` into `leadId`. */
export const mergeInto = (leadId: string, mergeLeadId: string) =>
  apiFetch<MergeResult>(`/v1/leads/${leadId}/merge`, { method: 'POST', auth: true, body: { mergeLeadId } });

export const undoMerge = (mergeId: string) =>
  apiFetch<{ survivorId: string; mergedId: string }>(`/v1/merges/${mergeId}/undo`, { method: 'POST', auth: true });

export const CHANNEL_LABEL: Record<LeadSubmission['channel'], string> = {
  webhook: 'Form / webhook',
  manual: 'Added by hand',
  import: 'Import',
  crm: 'CRM',
  sms: 'Text message',
  backfill: 'Original source',
};

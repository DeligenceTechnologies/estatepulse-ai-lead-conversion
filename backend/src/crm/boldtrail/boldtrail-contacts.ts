import type { CrmContact } from '../crm-records';

/**
 * A BoldTrail (kvCORE Public API V2) contact -> the provider-neutral CrmContact.
 * Pure: no HTTP, no database.
 *
 * Field names follow the kvCORE V2 contact resource. The published example has
 * a single `name`, while contacts read through the API also carry
 * `first_name` / `last_name`, so both are accepted and the split fields win.
 * Phones come in several slots; the first dialable-looking one is the primary,
 * mobile first, because that is the number the AI calls and texts.
 *
 * VERIFY AGAINST A SANDBOX ACCOUNT before turning this on for customers: the
 * phone slot names and the status codes below are from kvCORE's contact
 * documentation, which Inside Real Estate serves only to API partners.
 */

export interface BoldTrailContact {
  id?: number | string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  cell_phone_1?: string | null;
  cell_phone_2?: string | null;
  phone?: string | null;
  home_phone?: string | null;
  work_phone?: string | null;
  status?: number | string | null;
  deal_type?: string | null;
  source?: string | null;
  assigned_agent_id?: number | string | null;
  created_at?: string | number | null;
  updated_at?: string | number | null;
  deleted_at?: string | null;
}

/** Mobile first: it is the number outreach calls and texts. */
const PHONE_SLOTS = ['cell_phone_1', 'cell_phone_2', 'phone', 'home_phone', 'work_phone'] as const;

/** kvCORE's contact status codes. An unknown code is shown as it came. */
const STATUS_LABELS: Record<string, string> = {
  '0': 'New',
  '1': 'Client',
  '2': 'Closed',
  '3': 'Sphere',
  '4': 'Active',
  '5': 'Contract',
  '6': 'Archived',
  '7': 'Prospect',
};
const ARCHIVED_STATUS = '6';

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
};

/**
 * A contact this integration must treat as gone: soft-deleted, or archived by
 * the agent. Archived contacts are left alone on purpose. A clean lead goes
 * straight to outreach, and an agent who archived someone does not want the
 * AI calling them.
 */
export function isLiveBoldTrailContact(c: BoldTrailContact): boolean {
  if (text(c.id) === null) return false;
  if (text(c.deleted_at)) return false;
  return text(c.status) !== ARCHIVED_STATUS;
}

/** "Jane Q Public" -> ["Jane", "Q Public"]; a single word is a first name. */
function splitName(full: string | null): [string | null, string | null] {
  if (!full) return [null, null];
  const parts = full.replace(/\s+/g, ' ').trim().split(' ');
  if (parts.length === 1) return [parts[0], null];
  return [parts[0], parts.slice(1).join(' ')];
}

/**
 * BoldTrail times, in ms since the epoch: "YYYY-MM-DD HH:MM:SS" in UTC (the
 * V2 standard), an ISO string, or Unix seconds. 0 when unreadable, so an odd
 * value sorts first and is re-read rather than skipped.
 */
export function boldTrailTimeMs(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    // Seconds, unless it is already milliseconds.
    return n > 1e12 ? n : n * 1000;
  }
  const s = String(v).trim();
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(utc);
  return Number.isFinite(ms) ? ms : 0;
}

export function toCrmContact(c: BoldTrailContact): CrmContact {
  const [splitFirst, splitLast] = splitName(text(c.name));
  const first = text(c.first_name);
  const last = text(c.last_name);
  const phone = PHONE_SLOTS.map((k) => text(c[k])).find((p) => p !== null) ?? null;
  const status = text(c.status);
  return {
    externalId: String(c.id),
    firstName: first ?? (last ? null : splitFirst),
    lastName: last ?? (first ? null : splitLast),
    email: text(c.email),
    phone,
    extra: {
      'BoldTrail Status': status === null ? null : (STATUS_LABELS[status] ?? status),
      'BoldTrail Deal Type': text(c.deal_type),
      'BoldTrail Source': text(c.source),
      'BoldTrail Assigned Agent ID': text(c.assigned_agent_id),
    },
  };
}

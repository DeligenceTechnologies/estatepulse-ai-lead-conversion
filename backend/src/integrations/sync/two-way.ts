import type { Prisma } from '@prisma/client';
import type { ImportedRecord } from '../adapters/adapter.interface';

/**
 * Pure two-way sync rules. No database or HTTP here.
 *
 * Every linked record keeps a base per field, for each side: the value
 * EstatePulse had (`local`) and the value the provider had (`remote`) the last
 * time the two were reconciled. A side "changed" a field when its value now
 * differs from its own base. That is what makes the sync safe:
 *
 * - changed only in the provider      → the lead takes the provider's value
 * - changed only in EstatePulse       → the value is written to the provider
 * - changed in both, to the same value → nothing to do
 * - changed in both, differently      → EstatePulse wins (and is written back)
 * - first time a record is linked     → nothing is overwritten on either side;
 *   only a blank on the lead is filled, exactly as one-way import always did
 *
 * Bases are per side, so values that already differed when a record was first
 * linked (a lead that had another email before HubSpot sent its own) stay as
 * they are on both sides until one of them changes.
 */

/**
 * An adapter's own reason not to write a record (it is in a table no longer
 * synced...). Shown on the record as is; the change stays in EstatePulse.
 */
export class WriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRefused';
  }
}

export const SYNC_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'location',
  'timeline',
  'motivation',
  'minBudget',
  'maxBudget',
  'bedrooms',
] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];
export type SyncValue = string | number | null;
export type SyncValues = Partial<Record<SyncField, SyncValue>>;

export interface SyncState {
  v: 1;
  local: SyncValues;
  remote: SyncValues;
  /** Provider facts a write needs (e.g. which HubSpot phone property the number came from). */
  meta: Record<string, string>;
}

const NUMERIC: ReadonlySet<SyncField> = new Set(['minBudget', 'maxBudget', 'bedrooms']);
const MAX_LENGTH: Partial<Record<SyncField, number>> = {
  firstName: 100,
  lastName: 100,
  email: 255,
  phone: 50,
  location: 255,
  timeline: 100,
  motivation: 10_000,
};

export const isSyncField = (value: string): value is SyncField => (SYNC_FIELDS as readonly string[]).includes(value);

/** One field's value in the form both sides are compared in. */
export function normalize(field: SyncField, value: unknown): SyncValue {
  if (value === null || value === undefined) return null;
  if (NUMERIC.has(field)) {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.\-]/g, ''));
    if (!Number.isFinite(n) || String(value).trim() === '') return null;
    return field === 'bedrooms' ? Math.round(n) : Math.round(n * 100) / 100;
  }
  const text = String(value).trim();
  if (!text) return null;
  const max = MAX_LENGTH[field];
  return max ? text.slice(0, max) : text;
}

/** Equal for sync purposes: emails ignore case, phones ignore formatting, money ignores sub-cent noise. */
export function sameValue(field: SyncField, a: SyncValue | undefined, b: SyncValue | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (NUMERIC.has(field)) return Math.abs(Number(x) - Number(y)) < 0.005;
  if (field === 'email') return String(x).toLowerCase() === String(y).toLowerCase();
  if (field === 'phone') {
    const dx = String(x).replace(/[^\d]/g, '');
    const dy = String(y).replace(/[^\d]/g, '');
    return dx.length > 0 ? dx === dy : String(x) === String(y);
  }
  return x === y;
}

export type LeadSyncSource = Partial<Record<SyncField, string | number | Prisma.Decimal | null>>;

/** The lead's current values of `fields`. */
export function leadValues(lead: LeadSyncSource, fields: readonly SyncField[]): SyncValues {
  const out: SyncValues = {};
  for (const f of fields) {
    const raw = lead[f];
    out[f] = normalize(f, raw !== null && raw !== undefined && typeof raw === 'object' ? raw.toString() : raw);
  }
  return out;
}

/** The provider record's values of `fields`. */
export function recordValues(record: ImportedRecord, fields: readonly SyncField[]): SyncValues {
  const out: SyncValues = {};
  for (const f of fields) out[f] = normalize(f, record[f]);
  return out;
}

export function readState(json: unknown): SyncState {
  const o = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const side = (v: unknown): SyncValues => {
    const out: SyncValues = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (isSyncField(k) && (val === null || typeof val === 'string' || typeof val === 'number')) out[k] = val;
      }
    }
    return out;
  };
  const meta: Record<string, string> = {};
  if (o.meta && typeof o.meta === 'object' && !Array.isArray(o.meta)) {
    for (const [k, v] of Object.entries(o.meta as Record<string, unknown>)) if (typeof v === 'string') meta[k] = v;
  }
  return { v: 1, local: side(o.local), remote: side(o.remote), meta };
}

export const stateJson = (state: SyncState): Prisma.InputJsonValue => state as unknown as Prisma.InputJsonValue;

export interface InboundMerge {
  /** Fields to set on the lead, with the provider's value. */
  apply: SyncValues;
  /** Changed on both sides differently: EstatePulse's value was kept (and will be written back). */
  conflicts: SyncField[];
  next: SyncState;
}

/** A provider record arrived (new content): what the lead takes, and the new bases. */
export function mergeInbound(
  fields: readonly SyncField[],
  remoteNow: SyncValues,
  localNow: SyncValues,
  state: SyncState,
  meta: Record<string, string> = {},
): InboundMerge {
  const next: SyncState = { v: 1, local: { ...state.local }, remote: { ...state.remote }, meta: { ...state.meta, ...meta } };
  const apply: SyncValues = {};
  const conflicts: SyncField[] = [];

  for (const f of fields) {
    const r = remoteNow[f] ?? null;
    const l = localNow[f] ?? null;
    const hasBase = f in state.remote && f in state.local;

    if (!hasBase) {
      // First sight: fill a blank, never overwrite; both sides become the base.
      if (l === null && r !== null) {
        apply[f] = r;
        next.local[f] = r;
      } else {
        next.local[f] = l;
      }
      next.remote[f] = r;
      continue;
    }

    const remoteChanged = !sameValue(f, r, state.remote[f]);
    const localChanged = !sameValue(f, l, state.local[f]);
    if (!remoteChanged) continue;

    next.remote[f] = r;
    if (!localChanged) {
      apply[f] = r;
      next.local[f] = r;
    } else if (sameValue(f, r, l)) {
      // Both sides made the same change.
      next.local[f] = l;
    } else {
      // Both changed, differently: EstatePulse wins. Its base stays behind, so the write-back sees it as changed.
      conflicts.push(f);
    }
  }
  return { apply, conflicts, next };
}

export interface OutboundPlan {
  /** Changed in EstatePulse and writable: send these to the provider. */
  changes: SyncValues;
  /** Bases after accepting what needs no write (first sight, read-only fields). Apply `afterPush` once the write succeeds. */
  next: SyncState;
}

/** The lead may have changed: what to write to the provider. */
export function planOutbound(fields: readonly SyncField[], writable: readonly SyncField[], localNow: SyncValues, state: SyncState): OutboundPlan {
  const next: SyncState = { v: 1, local: { ...state.local }, remote: { ...state.remote }, meta: { ...state.meta } };
  const changes: SyncValues = {};
  const canWrite = new Set(writable);
  for (const f of fields) {
    const l = localNow[f] ?? null;
    if (!(f in state.local)) {
      // Never compared before: this is the base, not a change.
      next.local[f] = l;
      continue;
    }
    if (sameValue(f, l, state.local[f])) continue;
    if (canWrite.has(f)) changes[f] = l;
    // A column the provider will not accept writes to: the change stays in EstatePulse only.
    else next.local[f] = l;
  }
  return { changes, next };
}

/** The provider accepted `pushed`: both sides now hold these values. */
export function afterPush(state: SyncState, pushed: SyncValues): SyncState {
  const next: SyncState = { v: 1, local: { ...state.local }, remote: { ...state.remote }, meta: { ...state.meta } };
  for (const [f, v] of Object.entries(pushed) as [SyncField, SyncValue][]) {
    next.local[f] = v;
    next.remote[f] = v;
  }
  return next;
}

/** Same base, same meta: nothing worth writing. */
export function sameState(a: SyncState, b: SyncState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

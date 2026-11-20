import { ConsentStatus, LeadStatus, Prisma } from '@prisma/client';

/**
 * Pure rules for folding one record of a person into another: a new submission into the lead it
 * matched (fillBlanks) and a whole lead into another (resolveMerge). No database here, so every
 * rule is unit-tested (merge-rules.spec.ts).
 */

/** Contact and qualification fields a later record may fill when the lead has none. Never overwritten. */
export const FILLABLE_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'timezone',
  'location',
  'timeline',
  'buyingIntent',
  'financingStatus',
  'minBudget',
  'maxBudget',
  'bedrooms',
  'motivation',
  'utmSource',
  'utmMedium',
  'utmCampaign',
] as const;
export type FillableField = (typeof FILLABLE_FIELDS)[number];
export type FillableValues = Partial<Record<FillableField, string | number | Prisma.Decimal | null | undefined>>;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** The fields `incoming` has and `existing` lacks. What the lead already says is never replaced. */
export function fillBlanks(existing: FillableValues, incoming: FillableValues): FillableValues {
  const out: FillableValues = {};
  for (const f of FILLABLE_FIELDS) {
    if (isBlank(existing[f]) && !isBlank(incoming[f])) out[f] = incoming[f];
  }
  return out;
}

type JsonObject = Record<string, unknown>;
const asObject = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});

/** Keys from both; `primary` wins a key both have. */
export function mergeObjects(primary: unknown, secondary: unknown): JsonObject {
  return { ...asObject(secondary), ...asObject(primary) };
}

interface Answer {
  value?: unknown;
  at?: string;
  source?: string;
}

/**
 * Qualification answers (Lead.qualificationAnswers, key -> { value, at, source }): a manual answer
 * beats an AI one, as everywhere else; otherwise the newer answer wins.
 */
export function mergeAnswers(primary: unknown, secondary: unknown): JsonObject {
  const a = asObject(primary) as Record<string, Answer>;
  const b = asObject(secondary) as Record<string, Answer>;
  const out: JsonObject = { ...b, ...a };
  for (const key of Object.keys(b)) {
    if (!(key in a)) continue;
    const x = a[key];
    const y = b[key];
    const xManual = x?.source === 'manual';
    const yManual = y?.source === 'manual';
    if (xManual !== yManual) out[key] = xManual ? x : y;
    else out[key] = (Date.parse(y?.at ?? '') || 0) > (Date.parse(x?.at ?? '') || 0) ? y : x;
  }
  return out;
}

/** How far along the pipeline a status is; the survivor of a merge defaults to the further one. */
const STATUS_RANK: Record<LeadStatus, number> = {
  [LeadStatus.invalid]: 0,
  [LeadStatus.new]: 1,
  [LeadStatus.unresponsive]: 2,
  [LeadStatus.contacting]: 3,
  [LeadStatus.not_interested]: 4,
  [LeadStatus.follow_up]: 5,
  [LeadStatus.engaged]: 6,
  [LeadStatus.interested]: 7,
  [LeadStatus.appointment_requested]: 8,
  [LeadStatus.appointment_booked]: 9,
  [LeadStatus.closed]: 10,
};

export interface SurvivorFacts {
  id: string;
  status: LeadStatus;
  createdAt: Date;
  /** Calls plus messages. */
  activity: number;
}

/** The lead to keep by default: furthest along, then most talked to, then the older one. */
export function pickSurvivor(a: SurvivorFacts, b: SurvivorFacts): { survivor: string; merged: string } {
  const order =
    STATUS_RANK[b.status] - STATUS_RANK[a.status] || b.activity - a.activity || a.createdAt.getTime() - b.createdAt.getTime();
  return order > 0 ? { survivor: b.id, merged: a.id } : { survivor: a.id, merged: b.id };
}

/** revoked beats pending beats granted: a merge never gives consent the person did not give. */
const CONSENT_RANK: Record<ConsentStatus, number> = { granted: 0, pending: 1, revoked: 2 };

const earlier = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b);
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Every lead column a merge reads or may write; also what LeadMerge.survivorBefore keeps for undo. */
export const MERGE_LEAD_SELECT = {
  id: true,
  orgId: true,
  leadSourceId: true,
  createdAt: true,
  status: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  normalizedEmail: true,
  normalizedPhone: true,
  emailValid: true,
  phoneValid: true,
  externalLeadId: true,
  timezone: true,
  location: true,
  timeline: true,
  buyingIntent: true,
  financingStatus: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
  motivation: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  customFields: true,
  qualificationAnswers: true,
  memorySummary: true,
  memoryUpdatedAt: true,
  aiSummary: true,
  consentStatus: true,
  consentSource: true,
  consentAt: true,
  dncStatus: true,
  automationPaused: true,
  needsReview: true,
  reviewReasons: true,
  assignedToId: true,
  assignedAt: true,
  assignmentType: true,
  callbackAt: true,
  textBackAt: true,
  firstContactAt: true,
  firstResponseAt: true,
  lastContactAt: true,
  submissionCount: true,
  lastSubmissionAt: true,
  mergedIntoId: true,
} as const satisfies Prisma.LeadSelect;

export type MergeLead = Prisma.LeadGetPayload<{ select: typeof MERGE_LEAD_SELECT }>;

/** Reasons a merge settles, so they are not carried onto the survivor. */
export const DUPLICATE_REASON_PREFIX = 'Possible duplicate';

/**
 * What the survivor becomes. Its own values win; blanks are filled from the merged lead; dates
 * that bound the history take the wider range; do-not-contact and consent take the safer side;
 * and the source is the one the person first came from.
 */
export function resolveMerge(survivor: MergeLead, merged: MergeLead): Prisma.LeadUncheckedUpdateInput {
  const filled = fillBlanks(survivor, merged);
  const firstCameFrom = merged.createdAt < survivor.createdAt ? merged : survivor;
  const consentFrom = CONSENT_RANK[merged.consentStatus] > CONSENT_RANK[survivor.consentStatus] ? merged : survivor;
  const dnc = survivor.dncStatus || merged.dncStatus;
  const reviewReasons = [...new Set([...survivor.reviewReasons, ...merged.reviewReasons])].filter(
    (r) => !r.startsWith(DUPLICATE_REASON_PREFIX),
  );
  const contact = filled.phone ? { normalizedPhone: merged.normalizedPhone, phoneValid: merged.phoneValid } : {};
  const mail = filled.email ? { normalizedEmail: merged.normalizedEmail, emailValid: merged.emailValid } : {};
  return {
    ...(filled as Prisma.LeadUncheckedUpdateInput),
    ...contact,
    ...mail,
    leadSourceId: firstCameFrom.leadSourceId ?? survivor.leadSourceId ?? merged.leadSourceId,
    externalLeadId: survivor.externalLeadId ?? merged.externalLeadId,
    customFields: mergeObjects(survivor.customFields, merged.customFields) as Prisma.InputJsonValue,
    qualificationAnswers: mergeAnswers(survivor.qualificationAnswers, merged.qualificationAnswers) as Prisma.InputJsonValue,
    // Both notes, until the next conversation rewrites it from the combined history (LeadMemoryService).
    memorySummary: combineNotes(survivor.memorySummary, merged.memorySummary),
    consentStatus: consentFrom.consentStatus,
    consentSource: consentFrom.consentSource,
    consentAt: consentFrom.consentAt,
    dncStatus: dnc,
    automationPaused: survivor.automationPaused || dnc,
    reviewReasons,
    needsReview: reviewReasons.length > 0,
    assignedToId: survivor.assignedToId ?? merged.assignedToId,
    assignedAt: survivor.assignedToId ? survivor.assignedAt : merged.assignedAt,
    assignmentType: survivor.assignedToId ? survivor.assignmentType : merged.assignmentType,
    callbackAt: survivor.callbackAt ?? merged.callbackAt,
    firstContactAt: earlier(survivor.firstContactAt, merged.firstContactAt),
    firstResponseAt: earlier(survivor.firstResponseAt, merged.firstResponseAt),
    lastContactAt: later(survivor.lastContactAt, merged.lastContactAt),
    lastSubmissionAt: later(survivor.lastSubmissionAt, merged.lastSubmissionAt),
    submissionCount: survivor.submissionCount + merged.submissionCount,
  };
}

/**
 * The survivor's columns the merge changes, as they were before it: written back on undo. Only those —
 * a column the merge did not touch keeps whatever the lead's conversations have written since.
 */
export function snapshotForUndo(survivor: MergeLead, update: Prisma.LeadUncheckedUpdateInput): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(update)) {
    if (key in survivor) before[key] = (survivor as Record<string, unknown>)[key];
  }
  return JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
}

/** Joins two memory notes, newest knowledge first, within the 1200 characters a note may hold. */
export function combineNotes(survivor: string | null, merged: string | null, max = 1200): string | null {
  const parts = [survivor?.trim(), merged?.trim()].filter((p): p is string => !!p);
  if (parts.length < 2) return parts[0] ?? null;
  return parts.join('\n').slice(0, max);
}

const DATE_FIELDS = new Set([
  'consentAt',
  'memoryUpdatedAt',
  'assignedAt',
  'callbackAt',
  'textBackAt',
  'firstContactAt',
  'firstResponseAt',
  'lastContactAt',
  'lastSubmissionAt',
  'takenOverAt',
]);

/** A snapshot back into an update: JSON turned dates into strings and Decimals into strings. */
export function restoreFromSnapshot(snapshot: Record<string, unknown>): Prisma.LeadUncheckedUpdateInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (k === 'status') continue; // a status changed since the merge is real history; undo does not rewind it
    out[k] = DATE_FIELDS.has(k) && typeof v === 'string' ? new Date(v) : v;
  }
  return out as Prisma.LeadUncheckedUpdateInput;
}

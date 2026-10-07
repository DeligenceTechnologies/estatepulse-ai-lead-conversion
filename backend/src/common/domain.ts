/**
 * Domain constants for status columns.
 *
 * The Phase One schema models every status as `varchar` with a CHECK constraint
 * rather than as a Postgres enum, so Prisma generates no enum types for them.
 * We keep that convention deliberately — `ALTER TYPE ... ADD VALUE` cannot be
 * used in the same transaction that uses the new value, and Prisma wraps each
 * migration in a transaction, so enums make adding a status a two-migration
 * dance for no benefit.
 *
 * These `as const` objects give us the type safety back at the application
 * boundary without paying that cost in the database.
 */

/** webhook_events.queue_state — drives the worker claim loop. */
export const QueueState = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  DEAD_LETTER: 'DEAD_LETTER',
} as const;
export type QueueState = (typeof QueueState)[keyof typeof QueueState];

/**
 * webhook_events.outcome — the business result, as rendered in the Deliveries
 * UI. Deliberately a separate column from queue_state: merging them means every
 * new outcome value risks silently changing the poller's partial-index
 * predicate.
 */
export const DeliveryOutcome = {
  PROCESSED: 'PROCESSED',
  PROCESSED_WITH_WARNINGS: 'PROCESSED_WITH_WARNINGS',
  DUPLICATE: 'DUPLICATE',
  /** Stored and replayable; mapping incomplete, so no lead was created. */
  NEEDS_MAPPING: 'NEEDS_MAPPING',
  /** Mapped, but yielded neither a usable phone nor email. */
  NEEDS_IDENTITY: 'NEEDS_IDENTITY',
  /** HMAC failed. Raw body retained; never processed until the secret is fixed. */
  QUARANTINED_SIGNATURE: 'QUARANTINED_SIGNATURE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  ERROR: 'ERROR',
} as const;
export type DeliveryOutcome = (typeof DeliveryOutcome)[keyof typeof DeliveryOutcome];

export const SignatureState = {
  VALID: 'VALID',
  INVALID: 'INVALID',
  MISSING: 'MISSING',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
} as const;
export type SignatureState = (typeof SignatureState)[keyof typeof SignatureState];

/** lead_sources.ingest_status — drives the onboarding checklist in the UI. */
export const IngestStatus = {
  AWAITING_FIRST_EVENT: 'AWAITING_FIRST_EVENT',
  NEEDS_MAPPING: 'NEEDS_MAPPING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
} as const;
export type IngestStatus = (typeof IngestStatus)[keyof typeof IngestStatus];

export const MappingStatus = {
  UNCONFIGURED: 'UNCONFIGURED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  CONFIGURED: 'CONFIGURED',
} as const;
export type MappingStatus = (typeof MappingStatus)[keyof typeof MappingStatus];

export const FieldStatus = {
  NEW: 'NEW',
  ACTIVE: 'ACTIVE',
  MISSING: 'MISSING',
} as const;
export type FieldStatus = (typeof FieldStatus)[keyof typeof FieldStatus];

export const MappingOrigin = {
  HEURISTIC: 'HEURISTIC',
  USER: 'USER',
  IMPORTED: 'IMPORTED',
  /**
   * Derived from the provider's form SCHEMA at connect time, before any
   * submission existed. Distinct from HEURISTIC so "mapped from a real answer"
   * and "mapped from a question definition" stay tellable apart — they carry
   * different confidence, and only the latter can have a key we predicted
   * rather than observed.
   */
  PREBUILT: 'PREBUILT',
} as const;
export type MappingOrigin = (typeof MappingOrigin)[keyof typeof MappingOrigin];

/** Form providers we can drive through their management API. */
export const Provider = {
  TALLY: 'TALLY',
} as const;
export type Provider = (typeof Provider)[keyof typeof Provider];

/**
 * How a lead source's webhook got onto the customer's form.
 *
 * MANUAL: they pasted our URL and secret themselves. We cannot repair, pause or
 * remove it remotely — we hold no credential for their account.
 * API: we installed it with their API key, and can manage it.
 */
export const ConnectionMethod = {
  MANUAL: 'MANUAL',
  API: 'API',
} as const;
export type ConnectionMethod = (typeof ConnectionMethod)[keyof typeof ConnectionMethod];

/** What we believe about the webhook on the provider's side. */
export const RemoteWebhookState = {
  /** Row exists, install not yet confirmed. */
  PENDING: 'PENDING',
  INSTALLED: 'INSTALLED',
  /** Installed, but a later update (secret rotation, pause) failed to apply. */
  DRIFTED: 'DRIFTED',
  /** Confirmed absent on the provider — deliveries have stopped. */
  UNINSTALLED: 'UNINSTALLED',
  /** We disconnected locally but could not remove it remotely. */
  ORPHANED: 'ORPHANED',
  /** We could not establish the truth and must not guess. */
  ERROR: 'ERROR',
} as const;
export type RemoteWebhookState = (typeof RemoteWebhookState)[keyof typeof RemoteWebhookState];

export const CredentialStatus = {
  ACTIVE: 'ACTIVE',
  /** The provider rejected it; it needs replacing, not retrying. */
  INVALID: 'INVALID',
  REVOKED: 'REVOKED',
} as const;
export type CredentialStatus = (typeof CredentialStatus)[keyof typeof CredentialStatus];

/**
 * leads.consent_status. Matches the lowercase values the SPA's
 * `Lead['consentStatus']` union expects (src/types.ts).
 *
 * `revoked` is terminal with respect to the ingestion path: a public web form is
 * attacker-controlled input, so letting it flip revoked -> granted would mean
 * anyone who knows a phone number can re-subscribe someone who opted out.
 */
export const ConsentStatus = {
  GRANTED: 'granted',
  REVOKED: 'revoked',
  PENDING: 'pending',
} as const;
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];

/**
 * leads.status — matches the SPA's LeadStatus union in src/types.ts and the
 * leads_status_check constraint (migration 20261006000001_lead_status_v2).
 *
 * Lifecycle, left to right:
 *   new -> contacting -> contacted -> engaged -> qualified
 *       -> appointment_requested -> appointment_booked
 * Parked: follow_up (we reached them, no outcome yet), nurture (warm/cold or
 * never reached — a drip owns them).
 * Out: not_interested, dnc, invalid, closed.
 */
export const LeadStatus = {
  NEW: 'new',
  CONTACTING: 'contacting',
  CONTACTED: 'contacted',
  ENGAGED: 'engaged',
  QUALIFIED: 'qualified',
  APPOINTMENT_REQUESTED: 'appointment_requested',
  APPOINTMENT_BOOKED: 'appointment_booked',
  FOLLOW_UP: 'follow_up',
  NURTURE: 'nurture',
  NOT_INTERESTED: 'not_interested',
  DNC: 'dnc',
  INVALID: 'invalid',
  CLOSED: 'closed',
} as const;
export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

export const LEAD_STATUSES: readonly LeadStatus[] = Object.values(LeadStatus);

/**
 * The pre-v2 values. The constraint still accepts them so that a process
 * running older code against the same database keeps working; nothing in this
 * codebase writes them any more, and every read goes through
 * normalizeLeadStatus so they never reach the UI.
 */
export const LEGACY_BOOKED = 'booked';
export const LEGACY_LOST = 'lost';

/** A legacy or current status, as the current vocabulary. */
export function normalizeLeadStatus(status: string | null | undefined, dnc = false): LeadStatus {
  if (status === LEGACY_BOOKED) return LeadStatus.APPOINTMENT_BOOKED;
  // 'lost' carried both opt-outs (with dnc_status) and exhausted nurture.
  if (status === LEGACY_LOST) return dnc ? LeadStatus.DNC : LeadStatus.NOT_INTERESTED;
  return (LEAD_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as LeadStatus)
    : LeadStatus.NEW;
}

/** The stored values a status filter must match, legacy spellings included. */
export function statusFilterValues(status: string): string[] {
  if (status === LeadStatus.APPOINTMENT_BOOKED) return [status, LEGACY_BOOKED];
  if (status === LeadStatus.NOT_INTERESTED) return [status, LEGACY_LOST];
  return [status];
}

/**
 * Group-by counts with legacy values folded into their current name. Group by
 * ['status', 'dnc_status'] so a legacy 'lost' opt-out lands under 'dnc'.
 */
export function normalizeStatusCounts(
  rows: { status: string; dnc_status?: boolean; _count: { _all: number } }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of rows) {
    const s = normalizeLeadStatus(g.status, !!g.dnc_status);
    out[s] = (out[s] ?? 0) + g._count._all;
  }
  return out;
}

/**
 * The strategy engine is still working the lead. A lead leaves these the moment
 * the strategy ends, by any route.
 */
export const IN_STRATEGY_STATUSES: string[] = [
  LeadStatus.NEW,
  LeadStatus.CONTACTING,
  LeadStatus.CONTACTED,
  LeadStatus.ENGAGED,
];

/**
 * A result was reached: automation (strategy steps, drip steps) stops for good.
 * Includes the legacy spellings so a row written by older code still stops.
 */
export const OUTCOME_STATUSES: string[] = [
  LeadStatus.QUALIFIED,
  LeadStatus.APPOINTMENT_REQUESTED,
  LeadStatus.APPOINTMENT_BOOKED,
  LeadStatus.NOT_INTERESTED,
  LeadStatus.DNC,
  LeadStatus.INVALID,
  LeadStatus.CLOSED,
  LEGACY_BOOKED,
  LEGACY_LOST,
];

/** Out of the pipeline entirely — not a lead anybody is working. */
export const INACTIVE_STATUSES: string[] = [
  LeadStatus.NOT_INTERESTED,
  LeadStatus.DNC,
  LeadStatus.INVALID,
  LeadStatus.CLOSED,
  LEGACY_LOST,
];

/**
 * Where a lead may be moved FROM to reach `target` automatically.
 *
 * The outreach ladder only moves forward, so a late webhook (call.answered
 * arriving after the AI already qualified the lead) can never walk a lead back.
 * Parked leads (follow_up, nurture) re-enter at engaged when they reply.
 */
export const AUTO_FROM: Partial<Record<LeadStatus, string[]>> = {
  [LeadStatus.CONTACTING]: [LeadStatus.NEW],
  [LeadStatus.CONTACTED]: [LeadStatus.NEW, LeadStatus.CONTACTING],
  [LeadStatus.ENGAGED]: [
    LeadStatus.NEW,
    LeadStatus.CONTACTING,
    LeadStatus.CONTACTED,
    LeadStatus.FOLLOW_UP,
    LeadStatus.NURTURE,
  ],
};

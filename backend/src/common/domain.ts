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

/** leads.status — matches the SPA's LeadStatus union in src/types.ts. */
export const LeadStatus = {
  NEW: 'new',
  CONTACTED: 'contacted',
  ENGAGED: 'engaged',
  QUALIFIED: 'qualified',
  APPOINTMENT_BOOKED: 'appointment_booked',
  NURTURE: 'nurture',
  HUMAN_HANDOFF: 'human_handoff',
  CLOSED: 'closed',
  DNC: 'dnc',
  LOST: 'lost',
} as const;
export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

/**
 * Status ladder for the merge policy: a re-submission must never regress a lead
 * that is already mid-conversation. Higher wins.
 */
export const LEAD_STATUS_RANK: Record<string, number> = {
  [LeadStatus.NEW]: 0,
  [LeadStatus.CONTACTED]: 1,
  [LeadStatus.ENGAGED]: 2,
  [LeadStatus.QUALIFIED]: 3,
  [LeadStatus.APPOINTMENT_BOOKED]: 4,
};

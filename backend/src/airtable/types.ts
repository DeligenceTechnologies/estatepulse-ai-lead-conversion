import type { Prisma } from '@prisma/client';

/**
 * Airtable's shapes and failure vocabulary, in one place.
 *
 * Verified against the Web API documentation on 2026-11-13:
 *  - https://airtable.com/developers/web/api/oauth-reference
 *  - https://airtable.com/developers/web/api/scopes
 *  - https://airtable.com/developers/web/api/get-user-id-scopes
 *  - https://airtable.com/developers/web/api/rate-limits
 *
 * Tokens travel only in an Authorization header or a form-encoded POST body,
 * never in a URL. Nothing here ever puts a token in an error or a log line.
 */

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * REAUTH: the grant is dead (refresh expired past its 60 days, the user removed
 * the integration) or a required scope is gone — park the connection and ask
 * the owner to reconnect; never retry. UNAUTHORIZED: this access token was
 * rejected — refresh once, retry. RATE_LIMITED / UNAVAILABLE: transient.
 * SCOPE_MISSING: the call needs a permission this grant was never given —
 * permanent until the owner reconnects, but it does NOT kill the connection
 * (record sync keeps working without schema.bases:write).
 * Everything else is permanent for the request that hit it.
 */
export type AirtableErrorKind =
  | 'REAUTH'
  | 'UNAUTHORIZED'
  | 'SCOPE_MISSING'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'BAD_REQUEST';

/**
 * Deliberately not `CrmApiError`: Airtable is not a CRM adapter (it is scoped
 * to a base and table, which the CRM contract has no idea of), and importing
 * the CRM's error type would couple two integrations that must stay separable.
 */
export class AirtableApiError extends Error {
  constructor(
    readonly kind: AirtableErrorKind,
    /** Safe to log and to show: Airtable's own type/message, never a token or a cell value. */
    message: string,
    readonly status: number,
    /** How long Airtable asked us to wait, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'AirtableApiError';
  }

  get transient(): boolean {
    return this.kind === 'RATE_LIMITED' || this.kind === 'UNAVAILABLE';
  }
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Airtable's scope strings. Record write and schema write are SEPARATE
 * capabilities: being allowed to create a record says nothing about being
 * allowed to create a column, which is why Phase 4 gates on SCHEMA_WRITE alone.
 */
export const SCOPES = {
  RECORDS_READ: 'data.records:read',
  RECORDS_WRITE: 'data.records:write',
  SCHEMA_READ: 'schema.bases:read',
  SCHEMA_WRITE: 'schema.bases:write',
  WEBHOOK_MANAGE: 'webhook:manage',
  USER_EMAIL_READ: 'user.email:read',
} as const;

/**
 * Without these the integration cannot do anything at all: it could not list a
 * base (schema.bases:read) or read a record (data.records:read). A grant
 * missing either is refused at connect time rather than half-working.
 */
export const REQUIRED_SCOPES: readonly string[] = [SCOPES.SCHEMA_READ, SCOPES.RECORDS_READ];

/**
 * Asked for by default, and each one is optional: the integration degrades
 * instead of breaking when a deployment narrows AIRTABLE_SCOPES.
 *  - data.records:write  -> EstatePulse may create/update Airtable records
 *  - schema.bases:write  -> EstatePulse may create Airtable columns (Phase 4)
 *  - webhook:manage      -> incremental sync by webhook instead of a full re-read
 *  - user.email:read     -> whoami returns the email, so the card can name the account
 */
export const DEFAULT_SCOPES = [
  SCOPES.SCHEMA_READ,
  SCOPES.RECORDS_READ,
  SCOPES.RECORDS_WRITE,
  SCOPES.SCHEMA_WRITE,
  SCOPES.WEBHOOK_MANAGE,
  SCOPES.USER_EMAIL_READ,
].join(' ');

/** What the granted scopes allow, as the connection card and every guard read it. */
export interface AirtablePermissions {
  readRecords: boolean;
  writeRecords: boolean;
  readSchema: boolean;
  /** Creating columns. NEVER inferred from writeRecords — they are different grants. */
  writeSchema: boolean;
  manageWebhooks: boolean;
}

export function permissionsOf(scopes: readonly string[]): AirtablePermissions {
  const has = (s: string) => scopes.includes(s);
  return {
    readRecords: has(SCOPES.RECORDS_READ),
    writeRecords: has(SCOPES.RECORDS_WRITE),
    readSchema: has(SCOPES.SCHEMA_READ),
    writeSchema: has(SCOPES.SCHEMA_WRITE),
    manageWebhooks: has(SCOPES.WEBHOOK_MANAGE),
  };
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface AirtableTokens {
  accessToken: string;
  /** Seconds. Airtable documents 60 minutes. */
  expiresIn: number;
  /**
   * Airtable ROTATES on every refresh and invalidates the presented one
   * immediately, so the newest must always win the race to be stored.
   */
  refreshToken: string | null;
  /** Seconds. Airtable documents 60 days; unused for that long and the grant is gone. */
  refreshExpiresIn: number | null;
  /** The scopes actually granted to this token, as Airtable returns them. */
  scopes: string[] | null;
}

/** The Airtable user whose account authorized the connection. */
export interface AirtableAccount {
  /** `usr...` — Airtable's user id. The grant is per user, not per workspace. */
  userId: string;
  /** Only when user.email:read was granted. */
  email: string | null;
  /** Only ever returned for an OAuth token; a PAT would say nothing. */
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Bases, tables, fields, records
// ---------------------------------------------------------------------------

/**
 * Airtable's ids are opaque and stable; its display names are neither. Every id
 * is kept and every lookup is by id — a base, table or field renamed in
 * Airtable must not break a mapping or create a second lead source.
 */
export interface AirtableBase {
  /** `app...` */
  id: string;
  name: string;
  /** What this grant may do in the base: none | read | comment | edit | create. */
  permissionLevel?: string;
}

export interface AirtableField {
  /** `fld...` */
  id: string;
  name: string;
  /** Airtable's own type string, e.g. `singleLineText`, `multipleSelects`. */
  type: string;
  description?: string;
  /** Type-specific: select choices, number precision, currency symbol, and so on. */
  options?: Record<string, unknown>;
}

export interface AirtableTable {
  /** `tbl...` */
  id: string;
  name: string;
  description?: string;
  primaryFieldId?: string;
  fields?: AirtableField[];
}

export interface AirtableRecord {
  /** `rec...` — the stable external identity. Never an email or a phone number. */
  id: string;
  createdTime?: string;
  /** Keyed by FIELD ID, because we always ask for returnFieldsByFieldId. */
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * One payload from the webhook feed. Cell values are keyed by FIELD ID.
 *
 * Only the record ids are used: the payload says WHAT changed, and the records
 * are then re-read, so a value is never taken from a payload that may have been
 * superseded, and a payload missing an optional section cannot silently blank a
 * lead.
 */
export interface AirtableWebhookPayload {
  timestamp?: string;
  baseTransactionNumber?: number;
  /** Who made the change: `publicApi` is an API write, `client` a person in Airtable. */
  actionMetadata?: { source?: string; sourceMetadata?: { user?: { id?: string; email?: string } } };
  changedTablesById?: Record<
    string,
    {
      createdRecordsById?: Record<string, unknown>;
      changedRecordsById?: Record<string, unknown>;
      destroyedRecordIds?: string[];
    }
  >;
  error?: boolean;
  code?: string;
}

// ---------------------------------------------------------------------------
// Stored connection config (integrations.config)
// ---------------------------------------------------------------------------

/**
 * What we keep about the grant itself, beside the sealed refresh token. Never a
 * token, never anything secret: this one is safe to hand to the browser.
 */
export interface AirtableConnectionConfig {
  /** Granted scopes, exactly as Airtable reported them at connect/refresh. */
  scopes: string[];
  /** When the refresh token stops working if it is never used (Airtable: 60 days). */
  refreshExpiresAt: string | null;
  [k: string]: Prisma.JsonValue | undefined;
}

export function readConnectionConfig(value: Prisma.JsonValue | null | undefined): AirtableConnectionConfig {
  const raw = (value ?? {}) as Partial<AirtableConnectionConfig>;
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === 'string') : [];
  return { scopes, refreshExpiresAt: typeof raw.refreshExpiresAt === 'string' ? raw.refreshExpiresAt : null };
}

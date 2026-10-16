import type { CrmContact, CrmProviderLabel } from './crm-records';

/**
 * The contract every CRM adapter implements. Everything provider-specific —
 * URLs, scopes, property names, paging, error shapes — lives behind it, so the
 * connection, sync and review code never names a CRM. HubSpot is the only
 * implementation (hubspot/hubspot.client.ts).
 *
 * Tokens travel only in an Authorization header or a POST body, never in a URL.
 * No method here ever returns a token inside an error.
 */

/**
 * REAUTH: the grant is dead (revoked, uninstalled, refresh rejected) or lacks a
 * required scope — park the connection and ask the owner to reconnect; never
 * retry. UNAUTHORIZED: this access token was rejected — refresh once, retry.
 * RATE_LIMITED / UNAVAILABLE: transient — back off and retry later.
 * Everything else is permanent for the request that hit it.
 */
export type CrmErrorKind =
  | 'REAUTH'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'BAD_REQUEST';

export class CrmApiError extends Error {
  constructor(
    readonly kind: CrmErrorKind,
    /** Safe to log and to show: the provider's category/message, never a token or record value. */
    message: string,
    readonly status: number,
    /** How long the provider asked us to wait, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'CrmApiError';
  }

  get transient(): boolean {
    return this.kind === 'RATE_LIMITED' || this.kind === 'UNAVAILABLE';
  }
}

export interface CrmTokens {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Always returned by HubSpot; it may differ from the one presented (rotation), so the latest is kept. */
  refreshToken: string | null;
  /** Granted scopes, when the provider says. */
  scopes: string[] | null;
}

export interface CrmAccount {
  /** The CRM account (HubSpot: hub/portal id). */
  externalAccountId: string;
  /** A human label for it (HubSpot: hub domain). */
  accountName: string | null;
  /** The CRM user who authorized the connection. */
  userEmail: string | null;
  scopes: string[];
}

export interface CrmContactPage {
  contacts: CrmContact[];
  /** Opaque; null when this was the last page. */
  nextCursor: string | null;
}

export interface CrmChangedPage {
  contacts: (CrmContact & { modifiedAt: number })[];
  nextCursor: string | null;
  /**
   * The provider's search window is exhausted (HubSpot: 10,000 results per
   * query). The caller resumes from the last record's modifiedAt.
   */
  capped: boolean;
}

export interface CrmAdapter {
  /** lead_sources.provider / provider_credentials.provider. */
  readonly provider: string;
  readonly label: CrmProviderLabel;
  /** Scopes the connection cannot work without; a grant missing any is refused. */
  readonly requiredScopes: readonly string[];

  isConfigured(): boolean;
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<CrmTokens>;
  refresh(refreshToken: string): Promise<CrmTokens>;
  identify(accessToken: string): Promise<CrmAccount>;
  /** Best effort is the caller's call; this throws on failure. */
  revoke(refreshToken: string): Promise<void>;
  /** Remove the app from the CRM account entirely, so it stops sending webhooks. */
  uninstall(accessToken: string): Promise<void>;

  /** Every live (non-archived) contact, a page at a time. */
  listContacts(accessToken: string, cursor: string | null): Promise<CrmContactPage>;
  /** These contacts as they are now. Ids not returned are deleted, archived or merged away. */
  readContacts(accessToken: string, ids: string[]): Promise<{ found: CrmContact[]; missing: string[] }>;
  /** Contacts modified at or after `sinceMs`, oldest first. */
  changedContactsSince(accessToken: string, sinceMs: number, cursor: string | null): Promise<CrmChangedPage>;
}

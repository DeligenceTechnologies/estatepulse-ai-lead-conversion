import type { CrmContact, CrmProviderLabel } from './crm-records';

/**
 * The contract every CRM adapter implements. Everything provider-specific —
 * URLs, scopes, property names, paging, error shapes — lives behind it, so the
 * connection, sync and review code never names a CRM. Implementations:
 * hubspot/hubspot.client.ts (OAuth) and boldtrail/boldtrail.client.ts (API token).
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

/** What every CRM adapter does, however it is authorized: read contacts, and write back the few fields Import Review edits. */
interface CrmAdapterBase {
  /** lead_sources.provider / provider_credentials.provider. */
  readonly provider: string;
  readonly label: CrmProviderLabel;

  isConfigured(): boolean;

  /** Every live (non-archived) contact, a page at a time. */
  listContacts(accessToken: string, cursor: string | null): Promise<CrmContactPage>;
  /** These contacts as they are now. Ids not returned are deleted, archived or merged away. */
  readContacts(accessToken: string, ids: string[]): Promise<{ found: CrmContact[]; missing: string[] }>;
  /** Contacts modified at or after `sinceMs`, oldest first. */
  changedContactsSince(accessToken: string, sinceMs: number, cursor: string | null): Promise<CrmChangedPage>;
  /** Writes contact fields an owner corrected in Import Review; only the keys sent change. Needs the CRM's write scope. */
  updateContact(accessToken: string, externalId: string, fields: CrmContactUpdate): Promise<CrmContact>;
}

/** A CRM connected through its OAuth consent screen (HubSpot). The stored secret is a refresh token. */
export interface OAuthCrmAdapter extends CrmAdapterBase {
  readonly auth: 'oauth';
  /** Scopes the connection cannot work without; a grant missing any is refused. */
  readonly requiredScopes: readonly string[];

  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<CrmTokens>;
  refresh(refreshToken: string): Promise<CrmTokens>;
  identify(accessToken: string): Promise<CrmAccount>;
  /** Best effort is the caller's call; this throws on failure. */
  revoke(refreshToken: string): Promise<void>;
  /** Remove the app from the CRM account entirely, so it stops sending webhooks. */
  uninstall(accessToken: string): Promise<void>;
}

/** The account a pasted API token opens, as far as the CRM says. */
export interface CrmTokenAccount extends CrmAccount {
  /** When the token stops working, when the CRM says (BoldTrail: a year after it was generated). */
  expiresAt: Date | null;
}

/**
 * A CRM connected with an API token the owner generates in the CRM and pastes
 * here (BoldTrail). The token is the stored secret and the bearer token at
 * once: there is nothing to refresh and nothing to revoke from our side.
 */
export interface ApiTokenCrmAdapter extends CrmAdapterBase {
  readonly auth: 'api_token';
  /**
   * Proves the token can read contacts, and says which account it opens. A
   * token the CRM refuses throws REAUTH, UNAUTHORIZED or FORBIDDEN.
   */
  verifyToken(token: string): Promise<CrmTokenAccount>;
}

export type CrmAdapter = OAuthCrmAdapter | ApiTokenCrmAdapter;

/** The contact fields EstatePulse may write back to a CRM. */
export interface CrmContactUpdate {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

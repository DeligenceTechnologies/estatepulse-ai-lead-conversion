import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CRM_PROVIDER_LABELS, HUBSPOT_PROVIDER } from '../crm-records';
import { CrmApiError, type CrmAccount, type CrmAdapter, type CrmChangedPage, type CrmContactPage, type CrmTokens } from '../types';
import { HUBSPOT_CONTACT_PROPERTIES, modifiedAtMs, toCrmContact, type HubSpotObject } from './hubspot-contacts';

/**
 * Everything that talks to HubSpot over HTTP.
 *
 * Bare `fetch`, like google.client.ts and calendly.client.ts: a handful of
 * endpoints does not justify an SDK that would own our token handling.
 *
 * Endpoints are HubSpot's date-versioned ones (`/oauth/2026-09/token`,
 * `/crm/objects/2026-09/contacts`), which HubSpot recommends for new
 * integrations; the v1 OAuth endpoints stop working on 2027-02-16. The version
 * is configuration (HUBSPOT_API_VERSION) so a move to the next one is a
 * deploy, not a code change.
 *
 * Tokens and the client secret travel only in an Authorization header or a
 * form-encoded POST body — HubSpot's versioned OAuth endpoints reject sensitive
 * data in URLs outright. Error messages carry HubSpot's own category and
 * message, truncated; neither echoes a token.
 */

/** Without this a connection cannot read a single contact. `oauth` is added to every app by HubSpot. */
const REQUIRED_SCOPES = ['crm.objects.contacts.read'] as const;
const DEFAULT_SCOPES = 'oauth crm.objects.contacts.read';

/** HubSpot's maximum page size for the list and batch-read endpoints. */
export const PAGE_SIZE = 100;
/** Search allows up to 200 per page, and at most 10,000 results per query. */
const SEARCH_PAGE_SIZE = 200;
const SEARCH_RESULT_CAP = 10_000;

/** In-request retries for a transient failure; anything longer is the sync's backoff. */
const MAX_ATTEMPTS = 3;
/** A wait HubSpot asks for that is longer than this is handed back to the caller instead. */
const MAX_INLINE_WAIT_MS = 10_000;
/** HubSpot's daily limit resets at midnight in the account's time zone; an hour is a safe re-check. */
const DAILY_LIMIT_BACKOFF_MS = 3_600_000;

@Injectable()
export class HubSpotClient implements CrmAdapter {
  readonly provider = HUBSPOT_PROVIDER;
  readonly label = CRM_PROVIDER_LABELS[HUBSPOT_PROVIDER];
  readonly requiredScopes = REQUIRED_SCOPES;

  constructor(private readonly config: ConfigService) {}

  private get clientId(): string {
    return this.config.get<string>('HUBSPOT_CLIENT_ID') ?? '';
  }

  private get clientSecret(): string {
    return this.config.get<string>('HUBSPOT_CLIENT_SECRET') ?? '';
  }

  private get api(): string {
    return (this.config.get<string>('HUBSPOT_API_BASE_URL') ?? 'https://api.hubapi.com').replace(/\/+$/, '');
  }

  private get version(): string {
    return this.config.get<string>('HUBSPOT_API_VERSION') ?? '2026-09';
  }

  /** Base delay for in-request retries. Configurable only so tests do not sleep. */
  private get retryBaseMs(): number {
    return Number(this.config.get('HUBSPOT_RETRY_BASE_MS') ?? 1000);
  }

  /**
   * A static page on the APP's origin, as for Google: it hands the code to the
   * tab that started the flow, which completes it on its own session, so a code
   * never reaches an API URL or access log. Must match the redirect URL in the
   * HubSpot app's configuration exactly.
   */
  get redirectUri(): string {
    const override = this.config.get<string>('HUBSPOT_REDIRECT_URI');
    if (override) return override;
    const app = this.config.get<string>('APP_URL') ?? 'http://localhost:3000';
    return `${app.replace(/\/+$/, '')}/oauth/hubspot-callback.html`;
  }

  /**
   * Space-separated. Must include every REQUIRED scope configured on the
   * HubSpot app, or HubSpot's authorize page errors — so it is configuration,
   * for apps whose owner added more.
   */
  get scopes(): string {
    return (this.config.get<string>('HUBSPOT_SCOPES') ?? DEFAULT_SCOPES).trim().replace(/\s+/g, ' ');
  }

  /** The public URL registered as the app's webhook target; what HubSpot signs. */
  get webhookUrl(): string {
    const override = this.config.get<string>('HUBSPOT_WEBHOOK_URL');
    if (override) return override;
    const api = this.config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:4000';
    return `${api.replace(/\/+$/, '')}/ingest/v1/crm/hubspot/webhook`;
  }

  /** The secret webhook signatures are keyed with — HubSpot signs with the app's client secret. */
  get webhookSecret(): string {
    return this.clientSecret;
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl(state: string): string {
    const auth = (this.config.get<string>('HUBSPOT_AUTH_BASE_URL') ?? 'https://app.hubspot.com').replace(/\/+$/, '');
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, scope: this.scopes, state });
    return `${auth}/oauth/authorize?${q.toString()}`;
  }

  async exchangeCode(code: string): Promise<CrmTokens> {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
  }

  async refresh(refreshToken: string): Promise<CrmTokens> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * Who the token belongs to, by introspection — a POST with the token in the
   * body. (The legacy GET /oauth/v1/access-tokens/{token} put it in the path.)
   */
  async identify(accessToken: string): Promise<CrmAccount> {
    const res = await this.send(`${this.api}/oauth/${this.version}/token/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ client_id: this.clientId, client_secret: this.clientSecret, token: accessToken, token_type_hint: 'access_token' }),
    });
    if (!res.ok) throw await this.apiError(res);
    const body = (await res.json().catch(() => ({}))) as {
      active?: boolean;
      hub_id?: number | string;
      hub_domain?: string;
      user?: string;
      scopes?: string[];
    };
    if (body.active === false || body.hub_id === undefined || body.hub_id === null) {
      throw new CrmApiError('REAUTH', 'HubSpot did not recognise the new access token', 401);
    }
    return {
      externalAccountId: String(body.hub_id),
      accountName: typeof body.hub_domain === 'string' ? body.hub_domain.slice(0, 255) : null,
      userEmail: typeof body.user === 'string' ? body.user.slice(0, 255) : null,
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
    };
  }

  async revoke(refreshToken: string): Promise<void> {
    const res = await this.send(`${this.api}/oauth/${this.version}/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ client_id: this.clientId, client_secret: this.clientSecret, token: refreshToken, token_type_hint: 'refresh_token' }),
    });
    // 400/401 here means it is already dead, which is what we wanted.
    if (res.ok || res.status === 400 || res.status === 401) return;
    throw await this.apiError(res);
  }

  /**
   * Uninstalls the app from the HubSpot account (HubSpot emails its admins).
   * A revoked refresh token alone leaves the app installed, and an installed
   * app keeps receiving webhooks for the account.
   */
  async uninstall(accessToken: string): Promise<void> {
    const res = await this.send(`${this.api}/appinstalls/${this.version}/external-install`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok || res.status === 404) return;
    throw await this.apiError(res);
  }

  async listContacts(accessToken: string, cursor: string | null): Promise<CrmContactPage> {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), properties: HUBSPOT_CONTACT_PROPERTIES.join(','), archived: 'false' });
    if (cursor) q.set('after', cursor);
    const body = await this.json<{ results?: HubSpotObject[]; paging?: { next?: { after?: string } } }>(
      `${this.api}/crm/objects/${this.version}/contacts?${q.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    return {
      contacts: (body.results ?? []).map(toCrmContact),
      nextCursor: body.paging?.next?.after ?? null,
    };
  }

  async readContacts(accessToken: string, ids: string[]): Promise<{ found: ReturnType<typeof toCrmContact>[]; missing: string[] }> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { found: [], missing: [] };
    if (unique.length > PAGE_SIZE) throw new Error(`readContacts takes at most ${PAGE_SIZE} ids`);
    // 200, or 207 with per-id errors for the ones that do not exist (deleted,
    // archived, merged away). Anything not returned is treated as gone.
    const body = await this.json<{ results?: HubSpotObject[] }>(`${this.api}/crm/objects/${this.version}/contacts/batch/read?archived=false`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: unique.map((id) => ({ id })), properties: HUBSPOT_CONTACT_PROPERTIES }),
    });
    const found = (body.results ?? []).filter((r) => !r.archived).map(toCrmContact);
    const have = new Set(found.map((c) => c.externalId));
    return { found, missing: unique.filter((id) => !have.has(id)) };
  }

  async changedContactsSince(accessToken: string, sinceMs: number, cursor: string | null): Promise<CrmChangedPage> {
    const after = cursor ? Number(cursor) : 0;
    const body = await this.json<{ results?: HubSpotObject[]; paging?: { next?: { after?: string } } }>(
      `${this.api}/crm/objects/${this.version}/contacts/search`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(Math.max(0, Math.floor(sinceMs))) }] }],
          sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
          properties: HUBSPOT_CONTACT_PROPERTIES,
          limit: SEARCH_PAGE_SIZE,
          ...(after ? { after: String(after) } : {}),
        }),
      },
    );
    const next = body.paging?.next?.after ?? null;
    // Paging past 10,000 results is a 400; stop short and let the caller
    // re-query from the newest modified time it has seen.
    const capped = next !== null && Number(next) + SEARCH_PAGE_SIZE > SEARCH_RESULT_CAP;
    return {
      contacts: (body.results ?? []).map((o) => ({ ...toCrmContact(o), modifiedAt: modifiedAtMs(o) })),
      nextCursor: capped ? null : next,
      capped,
    };
  }

  // -------------------------------------------------------------------------

  private form(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<CrmTokens> {
    const res = await this.send(`${this.api}/oauth/${this.version}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scopes?: string[];
      error?: string;
      status?: string;
    };
    if (!res.ok || !body.access_token) {
      const err = body.error ?? body.status ?? `http_${res.status}`;
      // A dead refresh token, or an authorization code that is expired, used,
      // or minted for another redirect. The caller knows which and words it.
      if (err === 'invalid_grant' || body.status === 'BAD_REFRESH_TOKEN' || body.status === 'BAD_AUTH_CODE' || res.status === 401 || res.status === 403) {
        throw new CrmApiError('REAUTH', `HubSpot rejected the grant (${String(err).slice(0, 60)})`, res.status);
      }
      if (res.status === 429) throw new CrmApiError('RATE_LIMITED', 'HubSpot rate limit on the token endpoint', 429, retryAfter(res));
      if (res.status >= 500 || res.status === 0) throw new CrmApiError('UNAVAILABLE', 'HubSpot token endpoint unavailable', res.status);
      throw new CrmApiError('BAD_REQUEST', `HubSpot token endpoint refused the request (${String(err).slice(0, 60)})`, res.status);
    }
    return {
      accessToken: body.access_token,
      expiresIn: Number(body.expires_in ?? 1800),
      refreshToken: body.refresh_token ?? null,
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : null,
    };
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const res = await this.send(url, init);
    if (!res.ok) throw await this.apiError(res);
    return (await res.json()) as T;
  }

  /**
   * One request, retried in place for a short transient failure: a dropped
   * connection, a timeout, HubSpot's 10-second rate limit, a 502/503/504, a 423.
   * Bounded (three attempts) with exponential backoff and jitter, honouring
   * Retry-After when HubSpot sends one. A longer wait — the daily limit, a
   * Retry-After past ten seconds — is handed back as a CrmApiError carrying it,
   * for the sync to back off without holding anything open.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const timeout = Number(this.config.get('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000);
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      } catch {
        // The URL stays out of the message: it carries record ids.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoff(this.retryBaseMs, attempt));
          continue;
        }
        throw new CrmApiError('UNAVAILABLE', 'HubSpot did not respond', 0);
      }

      const transient = res.status === 429 || res.status === 423 || [502, 503, 504, 521, 523, 524].includes(res.status);
      if (!transient || attempt >= MAX_ATTEMPTS) return res;

      let wait = retryAfter(res) ?? backoff(this.retryBaseMs, attempt);
      if (res.status === 423) wait = Math.max(wait, 2_000);
      if (res.status === 429 && (await isDailyLimit(res.clone()))) return res;
      if (wait > MAX_INLINE_WAIT_MS) return res;
      await sleep(wait);
    }
  }

  private async apiError(res: Response): Promise<CrmApiError> {
    const body = (await res.json().catch(() => ({}))) as { message?: string; category?: string; policyName?: string };
    const message = `${body.category ? `${body.category}: ` : ''}${body.message ?? `HubSpot returned HTTP ${res.status}`}`.slice(0, 300);
    if (res.status === 429) {
      const daily = body.policyName === 'DAILY';
      return new CrmApiError('RATE_LIMITED', message, 429, daily ? DAILY_LIMIT_BACKOFF_MS : retryAfter(res));
    }
    if (res.status === 401) return new CrmApiError('UNAUTHORIZED', message, 401);
    // A 403 for a missing scope will not fix itself: the owner must reconnect
    // and grant it.
    if (res.status === 403) return new CrmApiError(body.category === 'MISSING_SCOPES' ? 'REAUTH' : 'FORBIDDEN', message, 403);
    if (res.status === 404) return new CrmApiError('NOT_FOUND', message, 404);
    if (res.status === 409) return new CrmApiError('CONFLICT', message, 409);
    if (res.status === 423 || res.status >= 500) return new CrmApiError('UNAVAILABLE', message, res.status, retryAfter(res));
    return new CrmApiError('BAD_REQUEST', message, res.status);
  }
}

/** Retry-After in seconds or as an HTTP date; null when absent or unreadable. */
function retryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function isDailyLimit(res: Response): Promise<boolean> {
  const body = (await res.json().catch(() => ({}))) as { policyName?: string };
  return body.policyName === 'DAILY';
}

/** base * 2^(attempt-1), ±20%. */
function backoff(base: number, attempt: number): number {
  return Math.round(base * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

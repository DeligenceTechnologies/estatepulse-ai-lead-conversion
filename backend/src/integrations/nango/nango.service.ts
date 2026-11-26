import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Nango, type ApiProvider, type ApiPublicConnectionFull, type ApiPublicIntegration, type ProxyConfiguration } from '@nangohq/node';
import { httpError } from '@/common/errors/app-error';
import type { NangoEnv } from '@/common/utils/interface';
import { NANGO_TAG } from '../integrations.constants';

/**
 * What the caller should do about a failed Nango call.
 * - REAUTH        the connection is gone or its grant is dead: ask the owner to reconnect; never retry.
 * - RATE_LIMITED  the provider (or Nango) said slow down: retry after a pause.
 * - UNAVAILABLE   Nango or the provider did not answer: transient, retry later.
 * - MISCONFIGURED our side is wrong (bad API key, unknown integration key): reconnecting will not help.
 * - REJECTED      the provider refused this particular request (400/403/404/422).
 */
export type NangoErrorKind = 'REAUTH' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'MISCONFIGURED' | 'REJECTED';

export class NangoError extends Error {
  constructor(
    readonly kind: NangoErrorKind,
    message: string,
    readonly status: number,
    /** Seconds the provider asked us to wait, when it said (Retry-After). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'NangoError';
  }
}

/** Who a connect session is for. Always taken from the signed-in session, never from the request body. */
export interface SessionOwner {
  organizationId: string;
  organizationName?: string | null;
  userId: string;
  email?: string | null;
  displayName?: string | null;
}

export interface ConnectSession {
  sessionToken: string;
  expiresAt: string;
}

/** Non-secret settings the browser needs to open Nango's Connect UI against the right deployment. */
export interface ConnectUiConfig {
  apiURL: string | null;
  baseURL: string | null;
}

const MISCONFIGURED_CODES = new Set([
  'unknown_account',
  'missing_auth_header',
  'malformed_auth_header',
  'invalid_permissions',
  'unknown_provider_config',
  'integration_not_allowed',
]);
const REAUTH_CODES = new Set(['unknown_connection', 'not_found', 'invalid_credentials', 'failed_to_refresh']);

const CATALOG_TTL_MS = 10 * 60_000;
const INTEGRATIONS_TTL_MS = 60_000;
const SECRET_TTL_MS = 60_000;
/** A cached access token is dropped this long before it expires, so a call never starts with a dying token. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * The one place that talks to Nango. Consent screens, credential storage and
 * token refresh are Nango's; this hands out short-lived connect sessions, reads
 * connections, proxies provider calls, and deletes connections.
 *
 * Nothing returned from here carries a token, with one exception: `secretOf`
 * hands a key or access token (Cal.com, Calendly) to the calendar module's
 * existing clients, which call the provider directly. It is held in memory for
 * at most a minute, never stored or logged. Everything else goes through
 * Nango's proxy. Errors
 * are classified from the HTTP status and Nango's error code only — never from
 * the request (which carries our API key) or a response body that could hold
 * provider data.
 */
@Injectable()
export class NangoService implements OnModuleInit {
  private readonly logger = new Logger('Nango');
  private readonly client: Nango | null;
  private readonly signingKey: string | null;
  private readonly ui: ConnectUiConfig;
  private catalog: { at: number; providers: ApiProvider[] } | null = null;
  private catalogLoading: Promise<ApiProvider[]> | null = null;
  private integrations: { at: number; configs: ApiPublicIntegration[] } | null = null;
  /** Credentials read for providers whose existing client needs them (Cal.com, Calendly). Memory only, short-lived. */
  private readonly apiKeys = new Map<string, { until: number; key: Promise<string> }>();

  constructor(config: ConfigService<NangoEnv, true>) {
    const apiKey = config.get('NANGO_SECRET_KEY', { infer: true }) || null;
    const host = config.get('NANGO_HOST', { infer: true }) || null;
    this.signingKey = config.get('NANGO_WEBHOOK_SIGNING_KEY', { infer: true }) || null;
    this.client = apiKey
      ? new Nango({ apiKey, ...(host ? { host } : {}), ...(this.signingKey ? { webhookSigningKey: this.signingKey } : {}) })
      : null;
    this.ui = { apiURL: host, baseURL: config.get('NANGO_CONNECT_UI_URL', { infer: true }) || null };
  }

  onModuleInit(): void {
    if (!this.client) {
      this.logger.warn('Nango is not configured (NANGO_SECRET_KEY unset): the marketplace lists integrations but none can be connected.');
    } else if (!this.signingKey) {
      this.logger.warn('NANGO_WEBHOOK_SIGNING_KEY is unset: Nango webhooks will be refused; revoked grants are only noticed on use.');
    }
  }

  get configured(): boolean {
    return this.client !== null;
  }

  get webhooksConfigured(): boolean {
    return Boolean(this.client && this.signingKey);
  }

  get connectUi(): ConnectUiConfig {
    return this.ui;
  }

  // ---------------------------------------------------------------------------
  // Catalog and environment
  // ---------------------------------------------------------------------------

  /** Every provider Nango supports (its public catalog), cached for ten minutes. */
  async listCatalog(): Promise<ApiProvider[]> {
    const client = this.require();
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.providers;
    // One request in flight however many browsers open the page at once.
    this.catalogLoading ??= client
      .listProviders({})
      .then((res) => {
        this.catalog = { at: Date.now(), providers: res.data };
        return res.data;
      })
      .catch((error: unknown) => {
        // A stale catalog beats an empty page while Nango is briefly unreachable.
        if (this.catalog) {
          this.logger.warn(`Nango catalog refresh failed, serving the cached one: ${this.classify(error, 'list providers').message}`);
          return this.catalog.providers;
        }
        throw this.toHttp(this.classify(error, 'list providers'));
      })
      .finally(() => {
        this.catalogLoading = null;
      });
    return this.catalogLoading;
  }

  /** One catalog provider, or null when Nango does not know it. */
  async catalogProvider(provider: string): Promise<ApiProvider | null> {
    const all = await this.listCatalog();
    return all.find((p) => p.name === provider) ?? null;
  }

  /**
   * The integrations configured in OUR Nango environment (dashboard → Integrations),
   * cached for a minute. `missing_fields` lists what still has to be filled in there.
   */
  async listConfigured(): Promise<ApiPublicIntegration[]> {
    const client = this.require();
    if (this.integrations && Date.now() - this.integrations.at < INTEGRATIONS_TTL_MS) return this.integrations.configs;
    try {
      const res = await client.listIntegrations();
      this.integrations = { at: Date.now(), configs: res.configs };
      return res.configs;
    } catch (error) {
      if (this.integrations) return this.integrations.configs;
      throw this.toHttp(this.classify(error, 'list integrations'));
    }
  }

  /** Drops the cached environment, e.g. after Nango said an integration key does not exist. */
  forgetConfigured(): void {
    this.integrations = null;
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  /**
   * A connect session limited to one integration and tagged with the caller's
   * organization and user. The tags are written by this server, so a connection
   * carrying them was made from a session we issued for that organization.
   */
  async createSession(providerConfigKey: string, owner: SessionOwner): Promise<ConnectSession> {
    const client = this.require();
    try {
      const res = await client.createConnectSession({
        allowed_integrations: [providerConfigKey],
        end_user: {
          id: owner.userId,
          ...(owner.email ? { email: owner.email } : {}),
          ...(owner.displayName ? { display_name: owner.displayName } : {}),
        },
        organization: { id: owner.organizationId, ...(owner.organizationName ? { display_name: owner.organizationName } : {}) },
        tags: this.tags(providerConfigKey, owner),
      });
      return { sessionToken: res.data.token, expiresAt: res.data.expires_at };
    } catch (error) {
      const e = this.classify(error, 'create a connect session');
      if (e.kind === 'REJECTED' || e.kind === 'REAUTH') {
        // A brand-new session has no grant to be dead: a 4xx means the integration key is wrong.
        this.forgetConfigured();
        throw this.toHttp(new NangoError('MISCONFIGURED', e.message, e.status));
      }
      throw this.toHttp(e);
    }
  }

  /** A session that re-authorizes an existing connection in place: same connection id, new grant. */
  async createReconnectSession(providerConfigKey: string, nangoConnectionId: string, owner: SessionOwner): Promise<ConnectSession> {
    const client = this.require();
    try {
      const res = await client.createReconnectSession({
        connection_id: nangoConnectionId,
        integration_id: providerConfigKey,
        end_user: { id: owner.userId, ...(owner.email ? { email: owner.email } : {}) },
        organization: { id: owner.organizationId },
        tags: this.tags(providerConfigKey, owner),
      });
      return { sessionToken: res.data.token, expiresAt: res.data.expires_at };
    } catch (error) {
      throw this.toHttp(this.classify(error, 'create a reconnect session'));
    }
  }

  /**
   * A connection, read from Nango. The caller must still check its tags: this
   * does not know which organization is asking.
   */
  async getConnection(providerConfigKey: string, nangoConnectionId: string, forceRefresh = false): Promise<ApiPublicConnectionFull> {
    const client = this.require();
    try {
      return await client.getConnection(providerConfigKey, nangoConnectionId, forceRefresh);
    } catch (error) {
      throw this.classify(error, 'read the connection');
    }
  }

  /**
   * The credential Nango holds for a connection, for a client that calls the
   * provider itself (the calendar module): an API key (Cal.com) or an OAuth
   * access token (Calendly), which Nango refreshes when it has expired.
   *
   * Cached in memory for at most a minute, and never past five minutes before
   * a token expires. `forceRefresh` makes Nango get a new token from the
   * provider now (after the provider rejected the current one). Throws
   * NangoError REAUTH when the connection is gone or holds neither.
   */
  async secretOf(providerConfigKey: string, nangoConnectionId: string, forceRefresh = false): Promise<string> {
    const cacheKey = `${providerConfigKey}\u0000${nangoConnectionId}`;
    const cached = this.apiKeys.get(cacheKey);
    if (!forceRefresh && cached && Date.now() < cached.until) return cached.key;

    const entry = { until: Date.now() + SECRET_TTL_MS, key: Promise.resolve('') };
    entry.key = this.getConnection(providerConfigKey, nangoConnectionId, forceRefresh).then((connection) => {
      const credentials = connection.credentials as { type?: string; apiKey?: unknown; access_token?: unknown; expires_at?: unknown };
      if (credentials.type === 'API_KEY' && typeof credentials.apiKey === 'string' && credentials.apiKey) return credentials.apiKey;
      if (credentials.type === 'OAUTH2' && typeof credentials.access_token === 'string' && credentials.access_token) {
        const expiresAt = credentials.expires_at ? new Date(credentials.expires_at as string | Date).getTime() : NaN;
        if (Number.isFinite(expiresAt)) entry.until = Math.min(entry.until, expiresAt - TOKEN_EXPIRY_MARGIN_MS);
        return credentials.access_token;
      }
      throw new NangoError('REAUTH', 'The connection holds no usable credential', 404);
    });
    this.apiKeys.set(cacheKey, entry);
    // A failed read is not cached: the next call asks Nango again.
    entry.key.catch(() => {
      if (this.apiKeys.get(cacheKey) === entry) this.apiKeys.delete(cacheKey);
    });
    return entry.key;
  }

  forgetApiKey(providerConfigKey: string, nangoConnectionId: string): void {
    this.apiKeys.delete(`${providerConfigKey}\u0000${nangoConnectionId}`);
  }

  /** The organization a connection was tagged for when our server created its session. */
  ownerOf(connection: Pick<ApiPublicConnectionFull, 'tags'>): { organizationId: string | null; userId: string | null } {
    const tags = connection.tags ?? {};
    return { organizationId: tags[NANGO_TAG.organizationId] ?? null, userId: tags[NANGO_TAG.userId] ?? null };
  }

  /** Removes the connection and its stored credentials from Nango. Already gone counts as done. */
  async deleteConnection(providerConfigKey: string, nangoConnectionId: string): Promise<void> {
    const client = this.require();
    this.forgetApiKey(providerConfigKey, nangoConnectionId);
    try {
      await client.deleteConnection(providerConfigKey, nangoConnectionId);
    } catch (error) {
      const e = this.classify(error, 'delete the connection');
      if (e.status === 404) return;
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Provider calls
  // ---------------------------------------------------------------------------

  /**
   * One provider API call through Nango's proxy, which adds (and refreshes) the
   * credentials. Throws NangoError, classified, on any non-2xx answer.
   */
  async proxy<T>(config: ProxyConfiguration & { providerConfigKey: string; connectionId: string }): Promise<T> {
    const client = this.require();
    try {
      const res = await client.proxy<T>(config);
      return res.data;
    } catch (error) {
      throw this.classify(error, `call ${config.method ?? 'GET'} ${config.endpoint}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  /** HMAC-SHA256 of the exact bytes received (X-Nango-Hmac-Sha256), keyed with the webhook signing key. */
  verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean {
    if (!this.client || !this.signingKey) return false;
    try {
      return this.client.verifyIncomingWebhookRequest(rawBody, headers);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  /** A NangoError as the API's error envelope. Never 401: the SPA reads a 401 as "your session ended". */
  toHttp(error: unknown, label = 'The provider'): unknown {
    if (!(error instanceof NangoError)) return error;
    switch (error.kind) {
      case 'REAUTH':
        return httpError(409, 'INTEGRATION_REAUTH_REQUIRED', `${label} access was revoked or has expired. Reconnect to continue.`);
      case 'MISCONFIGURED':
        this.logger.error(`Nango is misconfigured: ${error.message}`);
        return httpError(503, 'INTEGRATION_NOT_CONFIGURED', `${label} is not set up correctly on this server yet. Please contact support.`);
      case 'RATE_LIMITED':
        return httpError(429, 'RATE_LIMITED', `${label} is rate limiting requests. Try again in a minute.`);
      case 'REJECTED':
        return httpError(502, 'INTEGRATION_REQUEST_REJECTED', `${label} refused the request (HTTP ${error.status}).`);
      default:
        return httpError(502, 'INTEGRATION_UNAVAILABLE', `Could not reach ${label}. Try again shortly.`);
    }
  }

  /**
   * Nango's answers, by what the caller should do. The SDK throws axios errors;
   * only the status, Nango's error code and Retry-After are read from them.
   */
  classify(error: unknown, action: string): NangoError {
    if (error instanceof NangoError) return error;
    const res = (error as { response?: { status?: unknown; data?: unknown; headers?: Record<string, unknown> } } | null)?.response;
    const status = typeof res?.status === 'number' ? res.status : 0;
    const data = res?.data as { error?: { code?: unknown } | string } | undefined;
    const rawCode = data && typeof data === 'object' ? (typeof data.error === 'object' ? data.error?.code : data.error) : undefined;
    const code = typeof rawCode === 'string' ? rawCode.slice(0, 64) : '';
    const message = `Nango could not ${action} (HTTP ${status || 'none'}${code ? `, ${code}` : ''})`;
    const retryAfter = Number(res?.headers?.['retry-after']);
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : null;

    if (status === 429) return new NangoError('RATE_LIMITED', message, status, retryAfterSeconds);
    if (status === 0 || status >= 500) return new NangoError('UNAVAILABLE', message, status);
    // Nango's own codes (@nangohq/types ResDefaultErrors / AuthErrors) for "our environment is
    // wrong": a bad or missing API key, or an integration key that does not exist.
    if (MISCONFIGURED_CODES.has(code)) return new NangoError('MISCONFIGURED', message, status);
    // The connection is gone, or there is no usable credential behind it (Nango could not
    // refresh it, or the provider answered 401 to a freshly refreshed token).
    if (status === 401 || REAUTH_CODES.has(code)) return new NangoError('REAUTH', message, status);
    return new NangoError('REJECTED', message, status);
  }

  private tags(providerConfigKey: string, owner: SessionOwner): Record<string, string> {
    return {
      [NANGO_TAG.organizationId]: owner.organizationId,
      [NANGO_TAG.userId]: owner.userId,
      [NANGO_TAG.integration]: providerConfigKey,
    };
  }

  private require(): Nango {
    if (!this.client) {
      throw httpError(503, 'NANGO_NOT_CONFIGURED', 'Integrations are not set up on this server yet (NANGO_SECRET_KEY is missing).');
    }
    return this.client;
  }
}

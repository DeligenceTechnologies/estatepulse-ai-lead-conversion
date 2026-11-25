import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Nango, type ApiPublicConnectionFull } from '@nangohq/node';
import { httpError } from '@/common/errors/app-error';
import type { NangoEnv } from '@/common/utils/interface';
import { NANGO_INTEGRATIONS, NANGO_INTEGRATION_LABELS, NANGO_TAG, type NangoIntegration } from './nango.constants';

/**
 * REAUTH: the connection is gone or its grant is dead (refresh rejected,
 * revoked) — park it and ask the owner to reconnect; never retry.
 * UNAVAILABLE: Nango or the provider did not answer — transient, retry later.
 * MISCONFIGURED: our side is wrong (no or bad API key, unknown integration key)
 * — nothing the owner can fix by reconnecting.
 */
export type NangoErrorKind = 'REAUTH' | 'UNAVAILABLE' | 'MISCONFIGURED';

export class NangoError extends Error {
  constructor(
    readonly kind: NangoErrorKind,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'NangoError';
  }
}

/** Who a connect session is for. Always taken from the signed-in session, never from the request body. */
export interface NangoSessionOwner {
  organizationId: string;
  userId: string;
  email?: string | null;
}

export interface NangoSession {
  sessionToken: string;
  expiresAt: string;
}

/** A connection Nango holds, already checked to belong to the organization that asked. */
export interface OwnedConnection {
  connectionId: string;
  integration: NangoIntegration;
  /** The user who ran the connect session, from its tags. */
  userId: string | null;
  /** The provider's raw token response, for fields like Calendly's owner/organization URIs. Never logged or returned. */
  raw: Record<string, unknown>;
}

/**
 * The one place that talks to Nango. Consent screens, credential storage
 * (OAuth grants and API keys) and token refresh are Nango's; this hands out
 * short-lived connect sessions, reads credentials, and deletes connections.
 *
 * Tokens returned from here go straight into an Authorization header. They are
 * never logged, stored, or put in an error message.
 */
@Injectable()
export class NangoService implements OnModuleInit {
  private readonly logger = new Logger('Nango');
  private readonly client: Nango | null;
  private readonly signingKey: string | null;
  /**
   * API keys do not expire, and calls and texts read Telnyx's on every event,
   * so they are kept briefly in memory instead of asking Nango each time.
   * Dropped when Nango reports the connection changed or deleted.
   */
  private readonly apiKeys = new Map<string, { key: string; until: number }>();
  /** The integration keys set up in the Nango dashboard, asked for at most once a minute. */
  private dashboard: { keys: Set<string>; until: number } | null = null;

  constructor(config: ConfigService<NangoEnv, true>) {
    const apiKey = config.get('NANGO_SECRET_KEY', { infer: true }) || null;
    this.signingKey = config.get('NANGO_WEBHOOK_SIGNING_KEY', { infer: true }) || null;
    const host = config.get('NANGO_HOST', { infer: true }) || undefined;
    this.client = apiKey
      ? new Nango({ apiKey, ...(host ? { host } : {}), ...(this.signingKey ? { webhookSigningKey: this.signingKey } : {}) })
      : null;
  }

  onModuleInit(): void {
    if (!this.client) {
      this.logger.warn('Nango is not configured (NANGO_SECRET_KEY unset): no third-party account can be connected.');
    } else if (!this.signingKey) {
      this.logger.warn('NANGO_WEBHOOK_SIGNING_KEY is unset: Nango webhooks will be refused, so refresh failures are only noticed on use.');
    }
  }

  get configured(): boolean {
    return this.client !== null;
  }

  key(integration: NangoIntegration): string {
    return NANGO_INTEGRATIONS[integration];
  }

  /**
   * The integration keys that exist in the Nango dashboard, or null when
   * Nango cannot be asked right now (then nothing is assumed missing).
   */
  async dashboardIntegrations(): Promise<Set<string> | null> {
    if (!this.client) return null;
    if (this.dashboard && this.dashboard.until > Date.now()) return this.dashboard.keys;
    try {
      const res = await this.client.listIntegrations();
      const keys = new Set(res.configs.map((c) => c.unique_key));
      this.dashboard = { keys, until: Date.now() + 60_000 };
      return keys;
    } catch (error) {
      this.logger.warn(`Could not list the Nango integrations: ${this.classify(error, 'list the integrations').message}`);
      return null;
    }
  }

  /** Why this integration cannot be connected because of the Nango dashboard, or null. */
  async missingInDashboard(integration: NangoIntegration): Promise<string | null> {
    const keys = await this.dashboardIntegrations();
    if (!keys || keys.has(this.key(integration))) return null;
    return missingMessage(integration, this.key(integration));
  }

  /** The integration a providerConfigKey names, or null for one this app does not use. */
  integrationOf(providerConfigKey: string): NangoIntegration | null {
    const hit = (Object.keys(NANGO_INTEGRATIONS) as NangoIntegration[]).find((i) => NANGO_INTEGRATIONS[i] === providerConfigKey);
    return hit ?? null;
  }

  /**
   * A connect session limited to one integration and tagged with the caller's
   * organization. With `reconnectConnectionId` it re-authorizes that existing
   * connection in place (same connection id), which is how an expired or
   * revoked grant is repaired.
   */
  async createSession(integration: NangoIntegration, owner: NangoSessionOwner, reconnectConnectionId?: string | null): Promise<NangoSession> {
    const client = this.require(integration);
    const tags: Record<string, string> = {
      [NANGO_TAG.organizationId]: owner.organizationId,
      [NANGO_TAG.userId]: owner.userId,
      [NANGO_TAG.integration]: integration,
      ...(owner.email ? { [NANGO_TAG.userEmail]: owner.email } : {}),
    };
    try {
      const res = reconnectConnectionId
        ? await client.createReconnectSession({ connection_id: reconnectConnectionId, integration_id: this.key(integration), tags })
        : await client.createConnectSession({ allowed_integrations: [this.key(integration)], tags });
      return { sessionToken: res.data.token, expiresAt: res.data.expires_at };
    } catch (error) {
      const e = this.classify(error, 'create a connect session');
      // A new session has no grant to be dead: any 4xx means the request or the dashboard is wrong
      // (most often the integration does not exist under this key). Only a reconnect can find its connection gone.
      if (e.kind === 'REAUTH' && !reconnectConnectionId) {
        this.dashboard = null;
        this.logger.error(`Nango refused a connect session for "${this.key(integration)}": ${e.message}`);
        throw httpError(503, 'NANGO_MISCONFIGURED', missingMessage(integration, this.key(integration)));
      }
      throw this.toHttp(integration, e);
    }
  }

  /**
   * The connection, only if Nango tagged it with this organization when our
   * server created its session. A connection id from the browser is never
   * trusted on its own: one from another organization is simply not found.
   */
  async ownedConnection(integration: NangoIntegration, connectionId: string, organizationId: string): Promise<OwnedConnection> {
    const client = this.require(integration);
    let connection: ApiPublicConnectionFull;
    try {
      connection = await client.getConnection(this.key(integration), connectionId);
    } catch (error) {
      const e = this.classify(error, 'read the connection');
      if (e.kind === 'REAUTH') throw notFound(integration);
      throw this.toHttp(integration, e);
    }
    const tags = connection.tags ?? {};
    if (connection.provider_config_key !== this.key(integration) || tags[NANGO_TAG.organizationId] !== organizationId) {
      this.logger.warn(`Refused ${integration} connection ${connectionId}: not tagged for organization ${organizationId}`);
      throw notFound(integration);
    }
    const credentials = connection.credentials as { raw?: unknown };
    return {
      connectionId: connection.connection_id,
      integration,
      userId: tags[NANGO_TAG.userId] ?? null,
      raw: credentials.raw && typeof credentials.raw === 'object' ? (credentials.raw as Record<string, unknown>) : {},
    };
  }

  /**
   * The credential to put in the provider's Authorization header: a valid
   * OAuth access token (Nango refreshes it when it is near expiry), or the
   * API key for an API-key integration. `forceRefresh` asks for a new token
   * regardless, for the single retry after a provider answered 401.
   */
  async accessToken(integration: NangoIntegration, connectionId: string, forceRefresh = false): Promise<string> {
    const client = this.require(integration);
    const cacheKey = `${integration}:${connectionId}`;
    const cached = this.apiKeys.get(cacheKey);
    if (cached && !forceRefresh && cached.until > Date.now()) return cached.key;

    let connection: ApiPublicConnectionFull;
    try {
      connection = await client.getConnection(this.key(integration), connectionId, forceRefresh);
    } catch (error) {
      this.apiKeys.delete(cacheKey);
      throw this.classify(error, 'get the credentials');
    }
    const credentials = connection.credentials as { type?: string; access_token?: unknown; apiKey?: unknown };
    if (credentials.type === 'OAUTH2' && typeof credentials.access_token === 'string' && credentials.access_token) {
      return credentials.access_token;
    }
    if (credentials.type === 'API_KEY' && typeof credentials.apiKey === 'string' && credentials.apiKey) {
      this.apiKeys.set(cacheKey, { key: credentials.apiKey, until: Date.now() + API_KEY_CACHE_MS });
      return credentials.apiKey;
    }
    throw new NangoError('MISCONFIGURED', `The Nango integration "${this.key(integration)}" is neither OAuth 2 nor API key`, 0);
  }

  /** Forget a cached API key: the connection was changed or deleted in Nango. */
  forget(connectionId: string): void {
    for (const key of this.apiKeys.keys()) if (key.endsWith(`:${connectionId}`)) this.apiKeys.delete(key);
  }

  /** Removes the connection and its stored tokens from Nango. Already gone counts as done. */
  async deleteConnection(integration: NangoIntegration, connectionId: string): Promise<void> {
    const client = this.require(integration);
    this.forget(connectionId);
    try {
      await client.deleteConnection(this.key(integration), connectionId);
    } catch (error) {
      const e = this.classify(error, 'delete the connection');
      if (e.status === 404) return;
      throw e;
    }
  }

  /** Best effort, for clean-up paths that must not fail the caller. */
  async deleteQuietly(integration: NangoIntegration, connectionId: string): Promise<void> {
    try {
      await this.deleteConnection(integration, connectionId);
    } catch (error) {
      this.logger.warn(`Could not delete ${integration} connection ${connectionId} from Nango: ${(error as Error).message}`);
    }
  }

  /** HMAC-SHA256 over the exact bytes received (X-Nango-Hmac-Sha256), keyed with the environment's webhook signing key. */
  verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean {
    if (!this.client || !this.signingKey) return false;
    try {
      return this.client.verifyIncomingWebhookRequest(rawBody, headers);
    } catch {
      return false;
    }
  }

  get webhooksConfigured(): boolean {
    return Boolean(this.client && this.signingKey);
  }

  /** A NangoError as the API's error envelope. Never 401: the SPA reads a 401 as "your session ended". */
  toHttp(integration: NangoIntegration, error: unknown): unknown {
    if (!(error instanceof NangoError)) return error;
    const name = NANGO_INTEGRATION_LABELS[integration];
    switch (error.kind) {
      case 'REAUTH':
        return httpError(409, 'NANGO_REAUTH_REQUIRED', `${name} access was revoked or has expired. Reconnect ${name} to continue.`);
      case 'MISCONFIGURED':
        this.logger.error(`Nango is misconfigured for ${integration}: ${error.message}`);
        return httpError(503, 'NANGO_MISCONFIGURED', `${name} connections are not set up correctly on this server. Please contact support.`);
      default:
        return httpError(502, 'NANGO_UNAVAILABLE', `Could not reach ${name}. Try again shortly.`);
    }
  }

  private require(integration: NangoIntegration): Nango {
    if (!this.client) {
      throw httpError(503, 'NANGO_NOT_CONFIGURED', `${NANGO_INTEGRATION_LABELS[integration]} cannot be connected on this server yet. Set NANGO_SECRET_KEY.`);
    }
    return this.client;
  }

  /**
   * Nango's answers, by what the caller should do. The SDK throws its HTTP
   * client's error; only the status and Nango's error code are read from it,
   * never the request (which carries our API key) or a credential.
   */
  private classify(error: unknown, action: string): NangoError {
    if (error instanceof NangoError) return error;
    const res = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
    const status = typeof res?.status === 'number' ? res.status : 0;
    const data = res?.data as { error?: { code?: unknown } | string } | undefined;
    const rawCode = typeof data?.error === 'object' ? data.error?.code : data?.error;
    const code = typeof rawCode === 'string' ? rawCode : '';
    const detail = typeof data?.error === 'object' ? (data.error as { errors?: { message?: unknown }[] }).errors?.[0]?.message : undefined;
    const message = `Nango could not ${action} (HTTP ${status || 'none'}${code ? `, ${code}` : ''}${typeof detail === 'string' ? `: ${detail}` : ''})`;

    if (status === 0 || status === 429 || status >= 500) return new NangoError('UNAVAILABLE', message, status);
    // Our API key is missing or wrong, or the integration is not set up under the expected key.
    if (status === 401 || status === 403 || code === 'unknown_provider_config' || code === 'missing_provider_config') {
      return new NangoError('MISCONFIGURED', message, status);
    }
    // not_found, invalid_credentials, a failed refresh: the grant is unusable until reconnected.
    return new NangoError('REAUTH', message, status);
  }
}

const API_KEY_CACHE_MS = 5 * 60_000;

function missingMessage(integration: NangoIntegration, key: string): string {
  return `${NANGO_INTEGRATION_LABELS[integration]} is not set up in Nango yet. Add an integration with the unique key "${key}" in the Nango dashboard.`;
}

function notFound(integration: NangoIntegration) {
  return httpError(404, 'NANGO_CONNECTION_NOT_FOUND', `That ${NANGO_INTEGRATION_LABELS[integration]} connection was not found. Start the connection again.`);
}

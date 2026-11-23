import { Injectable, Logger } from '@nestjs/common';
import { Integration, IntegrationProvider, IntegrationStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectionAlertService } from '@/common/service/connection-alert.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, sha256Hex } from '@/common/utils/crypto';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { openState, sealState } from '@/google-sheets/oauth-state';
import { AirtableClient } from './airtable.client';
import {
  AirtableApiError,
  REQUIRED_SCOPES,
  permissionsOf,
  readConnectionConfig,
  type AirtablePermissions,
  type AirtableTokens,
} from './types';

export type { SessionIdentity };

/**
 * An Airtable account connected to an organization: the OAuth flow, the stored
 * grant, access tokens, and disconnect.
 *
 * Where things live:
 *  - the grant: an integrations row (provider 'airtable'). The refresh token is
 *    sealed to (organization, row id), opened only here, and never returned,
 *    logged or put in an error. Access tokens live in process memory only.
 *  - what the grant may do: integrations.config.scopes, exactly as Airtable
 *    reported them. Read-only data for the UI; every guard reads it too.
 *  - an authorization in flight: a sealed state carrying the PKCE verifier,
 *    single-use, as for Google.
 *
 * Policy: an Airtable account is connected at most once per organization
 * (a reconnect updates that row in place). Bases and tables are chosen
 * afterwards, one lead source each — the connection itself imports nothing.
 */

/** Binds an Airtable OAuth state to this flow, so a Google or CRM state cannot complete it. */
const AIRTABLE_STATE_AAD = 'airtable:oauth_state:v1';
const TX_LIMITS = { maxWait: 10_000, timeout: 20_000 } as const;
/** Refresh this long before Airtable's 60-minute expiry, so a token never dies mid-page. */
const EARLY_REFRESH_MS = 5 * 60 * 1000;

/** Selected so the ciphertext can never ride along into a DTO by accident. */
const CREDENTIAL_ROW = {
  id: true,
  orgId: true,
  credentials: true,
  credentialHash: true,
  status: true,
  config: true,
} as const;
type CredentialRow = Prisma.IntegrationGetPayload<{ select: typeof CREDENTIAL_ROW }>;

/** Everything the connection card shows. Never a token. */
export interface AirtableConnectionDTO {
  id: string;
  /** The Airtable user whose account this is. */
  accountId: string | null;
  accountEmail: string | null;
  status: IntegrationStatus;
  permissions: AirtablePermissions;
  scopes: string[];
  /** Scopes this deployment asked for but Airtable did not grant. */
  missingScopes: string[];
  /** When the grant lapses if it is never used again (Airtable: 60 days). */
  refreshExpiresAt: string | null;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  connectedAt: Date;
}

@Injectable()
export class AirtableConnectionsService {
  private readonly logger = new Logger('AirtableConnections');
  /** credential id -> access token. Memory only, by design. */
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  /** credential id -> the refresh in flight: concurrent callers share one instead of racing. */
  private readonly refreshing = new Map<string, Promise<string>>();
  /**
   * OAuth states already redeemed, so one cannot be spent twice.
   *
   * ponytail: in process memory, so a second API instance would not know what
   * this one has seen. It is defence in depth rather than the control that
   * matters — a state is sealed to one organization, user and session, and the
   * provider invalidates its own authorization code after a single use, so a
   * replay needs the victim's session and still dies at the provider. Move it
   * to shared storage (and do it for Airtable, HubSpot and Google together, as
   * all three carry this same map) before running more than one instance.
   */
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AirtableClient,
    private readonly secrets: SecretBoxService,
    private readonly audit: AuditService,
    private readonly connectionAlerts: ConnectionAlertService,
  ) {}

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  start(who: SessionIdentity): { authorizeUrl: string; state: string } {
    if (!this.client.isConfigured()) {
      throw httpError(400, 'AIRTABLE_NOT_CONFIGURED', 'Airtable is not configured on this server. Set its client id and secret.');
    }
    const missing = this.client.missingRequiredRequests();
    if (missing.length) {
      throw httpError(
        400,
        'AIRTABLE_SCOPES_INSUFFICIENT',
        `AIRTABLE_SCOPES must request ${missing.join(', ')} — Airtable cannot be read without it.`,
      );
    }
    // The verifier is sealed inside the state, so only this session can redeem the code.
    const { state, codeChallenge } = sealState(this.secrets, who, Date.now(), AIRTABLE_STATE_AAD);
    return { authorizeUrl: this.client.authorizeUrl(state, codeChallenge), state };
  }

  /** Finish an authorization on the session that started it, once. */
  async complete(who: SessionIdentity, code: string, state: string): Promise<AirtableConnectionDTO> {
    const verifier = this.consumeState(who, state);

    let tokens: AirtableTokens;
    try {
      tokens = await this.client.exchangeCode(code, verifier);
    } catch (e) {
      if (e instanceof AirtableApiError && (e.kind === 'REAUTH' || e.kind === 'BAD_REQUEST')) {
        throw httpError(400, 'OAUTH_CODE_REJECTED', 'Airtable rejected the authorization. Start the connection again.');
      }
      throw this.toHttp(e);
    }
    if (!tokens.refreshToken) {
      throw httpError(502, 'AIRTABLE_NO_REFRESH_TOKEN', 'Airtable did not issue a long-lived token. Try connecting again.');
    }
    const refreshToken = tokens.refreshToken;

    let account;
    try {
      account = await this.client.identify(tokens.accessToken);
    } catch {
      throw httpError(502, 'AIRTABLE_IDENTITY_MISSING', 'Airtable did not say which account was connected. Try again.');
    }

    // whoami is the authority on what was granted; the token response is a
    // fallback for the rare case it says nothing.
    const granted = account.scopes.length ? account.scopes : (tokens.scopes ?? []);
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length) {
      throw httpError(
        400,
        'AIRTABLE_SCOPE_NOT_GRANTED',
        `Airtable did not grant ${missing.join(', ')}. Connect again and approve every requested permission.`,
      );
    }

    const refreshExpiresAt = tokens.refreshExpiresIn ? new Date(Date.now() + tokens.refreshExpiresIn * 1000).toISOString() : null;
    const saved = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.integration.findFirst({
        where: { orgId: who.organizationId, provider: IntegrationProvider.airtable, externalAccountId: account.userId, revokedAt: null },
        select: { id: true },
      });
      // The id exists before sealing: the AAD binds the ciphertext to its row.
      const id = existing?.id ?? randomUUID();
      const data = {
        credentials: this.secrets.seal(refreshToken, aad.integration(who.organizationId, id)),
        credentialHash: sha256Hex(refreshToken),
        credentialPreview: 'oauth',
        label: account.email ?? account.userId,
        accountName: account.email,
        accountEmail: account.email,
        externalAccountId: account.userId,
        config: { scopes: [...granted].sort(), refreshExpiresAt } satisfies Prisma.InputJsonValue,
        status: IntegrationStatus.active,
        lastVerifiedAt: new Date(),
        lastErrorAt: null,
        lastErrorCode: null,
      };
      const row = existing
        ? await tx.integration.update({ where: { id }, data })
        : await tx.integration.create({ data: { id, orgId: who.organizationId, provider: IntegrationProvider.airtable, ...data } });

      await this.audit.record(
        {
          orgId: who.organizationId,
          actorType: 'user',
          actorId: who.userId,
          action: existing ? 'airtable.reconnected' : 'airtable.connected',
          entityType: 'integration',
          entityId: id,
          payload: { accountId: account.userId, authorizedBy: account.email, scopes: [...granted].sort() },
        },
        tx,
      );
      return row;
    }, TX_LIMITS);

    this.accessTokens.set(saved.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    this.logger.log(`Airtable connected for organization ${who.organizationId} (credential ${saved.id})`);
    return this.toDTO(saved);
  }

  /** The state must come back to the same session that started it, unexpired, once. Returns its PKCE verifier. */
  private consumeState(who: SessionIdentity, state: string): string {
    const p = openState(this.secrets, state, AIRTABLE_STATE_AAD);
    if (!p) throw httpError(400, 'OAUTH_STATE_INVALID', 'This Airtable authorization is not valid. Start the connection again.');
    if (p.exp < Date.now()) throw httpError(400, 'OAUTH_STATE_EXPIRED', 'This Airtable authorization expired. Start the connection again.');
    if (p.org !== who.organizationId || p.usr !== who.userId || p.sid !== who.sessionId) {
      throw httpError(403, 'OAUTH_SESSION_MISMATCH', 'This Airtable authorization was started from a different session. Start it again from this window.');
    }
    const now = Date.now();
    for (const [n, e] of this.usedNonces) if (e < now) this.usedNonces.delete(n);
    if (this.usedNonces.has(p.nonce)) {
      throw httpError(400, 'OAUTH_STATE_USED', 'This Airtable authorization was already used. Start the connection again.');
    }
    this.usedNonces.set(p.nonce, p.exp);
    return p.cv;
  }

  // -------------------------------------------------------------------------
  // Reading connections
  // -------------------------------------------------------------------------

  async list(orgId: string): Promise<AirtableConnectionDTO[]> {
    const rows = await this.prisma.integration.findMany({
      where: { orgId, provider: IntegrationProvider.airtable, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDTO(r));
  }

  /** One connection, only if it belongs to the caller's organization: another's id is simply not found. */
  async mustFind(orgId: string, id: string): Promise<Integration> {
    const row = id
      ? await this.prisma.integration.findFirst({ where: { id, orgId, provider: IntegrationProvider.airtable, revokedAt: null } })
      : null;
    if (!row) throw httpError(404, 'AIRTABLE_NOT_CONNECTED', 'That Airtable connection does not exist.');
    return row;
  }

  /** What this connection may do, from the scopes Airtable granted it. */
  async permissions(orgId: string, id: string): Promise<AirtablePermissions> {
    return permissionsOf(readConnectionConfig((await this.mustFind(orgId, id)).config).scopes);
  }

  toDTO(row: Integration): AirtableConnectionDTO {
    const { scopes, refreshExpiresAt } = readConnectionConfig(row.config);
    return {
      id: row.id,
      accountId: row.externalAccountId,
      accountEmail: row.accountEmail,
      status: row.status,
      permissions: permissionsOf(scopes),
      scopes,
      missingScopes: this.client.requestedScopes.filter((s) => !scopes.includes(s)),
      refreshExpiresAt,
      lastVerifiedAt: row.lastVerifiedAt,
      lastErrorCode: row.lastErrorCode,
      connectedAt: row.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  /**
   * Stop using the grant and forget it, keeping the data. Airtable documents no
   * token revocation endpoint, so the refresh token is dropped here and simply
   * lapses (60 days unused); an owner who wants it gone immediately removes the
   * integration in their Airtable account settings. Imported leads and their
   * tracking rows are untouched, so reconnecting the same account picks them
   * straight back up.
   */
  async disconnect(who: SessionIdentity, id: string): Promise<void> {
    const row = await this.mustFind(who.organizationId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.integration.update({
        where: { id: row.id },
        data: { status: IntegrationStatus.revoked, revokedAt: new Date(), credentials: '', credentialHash: null },
      });
      await this.audit.record(
        {
          orgId: who.organizationId,
          actorType: 'user',
          actorId: who.userId,
          action: 'airtable.disconnected',
          entityType: 'integration',
          entityId: row.id,
          payload: { accountId: row.externalAccountId },
        },
        tx,
      );
    }, TX_LIMITS);
    this.accessTokens.delete(row.id);
    this.logger.log(`Airtable disconnected for organization ${who.organizationId} (credential ${row.id})`);
  }

  // -------------------------------------------------------------------------
  // Access tokens
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` with a valid access token for this connection. A 401 drops the
   * cached token and retries once on a fresh one. A second 401, or a dead
   * refresh token, parks the connection (invalid) and surfaces as REAUTH, which
   * no caller retries.
   *
   * A SCOPE_MISSING is deliberately NOT a reauthorization: a connection without
   * schema.bases:write is a working connection that cannot create columns.
   */
  async withAccessToken<T>(orgId: string, credentialId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    const row = await this.loadCredential(orgId, credentialId);
    try {
      return await fn(await this.accessToken(row));
    } catch (e) {
      if (e instanceof AirtableApiError && e.kind === 'REAUTH') await this.markInvalid(row, 'AIRTABLE_REAUTH_REQUIRED');
      if (!(e instanceof AirtableApiError && e.kind === 'UNAUTHORIZED')) throw e;
    }
    this.accessTokens.delete(row.id);
    try {
      return await fn(await this.accessToken(row));
    } catch (e) {
      if (e instanceof AirtableApiError && e.kind === 'UNAUTHORIZED') {
        await this.markInvalid(row, 'AIRTABLE_REAUTH_REQUIRED');
        throw new AirtableApiError('REAUTH', 'Airtable refused a freshly issued token', 401);
      }
      if (e instanceof AirtableApiError && e.kind === 'REAUTH') await this.markInvalid(row, 'AIRTABLE_REAUTH_REQUIRED');
      throw e;
    }
  }

  private async loadCredential(orgId: string, credentialId: string): Promise<CredentialRow> {
    // An undefined id would drop the filter and match any row in the organization.
    if (!credentialId) throw new AirtableApiError('REAUTH', 'No connection', 0);
    const row = await this.prisma.integration.findFirst({
      where: { id: credentialId, orgId, provider: IntegrationProvider.airtable, revokedAt: null },
      select: CREDENTIAL_ROW,
    });
    if (!row) throw new AirtableApiError('REAUTH', 'Airtable was disconnected', 0);
    if (row.status !== IntegrationStatus.active) throw new AirtableApiError('REAUTH', 'Airtable needs to be reconnected', 0);
    return row;
  }

  private accessToken(row: CredentialRow): Promise<string> {
    const cached = this.accessTokens.get(row.id);
    if (cached && cached.expiresAt - EARLY_REFRESH_MS > Date.now()) return Promise.resolve(cached.token);
    let inFlight = this.refreshing.get(row.id);
    if (!inFlight) {
      inFlight = this.refreshNow(row).finally(() => this.refreshing.delete(row.id));
      this.refreshing.set(row.id, inFlight);
    }
    return inFlight;
  }

  /**
   * One refresh, safe with several API instances.
   *
   * Airtable rotates on every refresh and invalidates the presented token
   * immediately, so two instances refreshing at once would otherwise leave the
   * loser's token stored and the connection dead. Guarded twice: a rejected or
   * conflicted (409) refresh re-reads the row in case another instance already
   * rotated it, and the new token is stored with a compare-and-swap on the hash
   * of the token presented, so a stale instance never overwrites a newer one.
   */
  private async refreshNow(row: CredentialRow): Promise<string> {
    let presented = this.decrypt(row);
    let presentedHash = row.credentialHash;
    let tokens: AirtableTokens;
    try {
      tokens = await this.client.refresh(presented);
    } catch (e) {
      const retryable = e instanceof AirtableApiError && (e.kind === 'REAUTH' || e.kind === 'CONFLICT');
      if (!retryable) throw e;
      const latest = await this.prisma.integration.findFirst({
        where: { id: row.id, orgId: row.orgId, revokedAt: null },
        select: CREDENTIAL_ROW,
      });
      if (!latest || latest.status !== IntegrationStatus.active || latest.credentialHash === row.credentialHash) {
        await this.markInvalid(row, 'AIRTABLE_REAUTH_REQUIRED');
        throw e;
      }
      // Another instance rotated it while we waited: use what it stored.
      presented = this.decrypt(latest);
      presentedHash = latest.credentialHash;
      try {
        tokens = await this.client.refresh(presented);
      } catch (again) {
        if (again instanceof AirtableApiError && again.kind === 'REAUTH') await this.markInvalid(latest, 'AIRTABLE_REAUTH_REQUIRED');
        throw again;
      }
    }

    // An owner can narrow what the integration may do without revoking it.
    const granted = tokens.scopes;
    if (granted && REQUIRED_SCOPES.some((s) => !granted.includes(s))) {
      await this.markInvalid(row, 'AIRTABLE_SCOPE_NOT_GRANTED');
      throw new AirtableApiError('REAUTH', 'Airtable no longer grants a required permission', 403);
    }

    const data: Prisma.IntegrationUpdateManyMutationInput = { lastVerifiedAt: new Date() };
    if (tokens.refreshToken && tokens.refreshToken !== presented) {
      data.credentials = this.secrets.seal(tokens.refreshToken, aad.integration(row.orgId, row.id));
      data.credentialHash = sha256Hex(tokens.refreshToken);
    }
    if (granted || tokens.refreshExpiresIn) {
      const current = readConnectionConfig(row.config);
      data.config = {
        scopes: granted ? [...granted].sort() : current.scopes,
        refreshExpiresAt: tokens.refreshExpiresIn ? new Date(Date.now() + tokens.refreshExpiresIn * 1000).toISOString() : current.refreshExpiresAt,
      } satisfies Prisma.InputJsonValue;
    }
    const saved = await this.prisma.integration.updateMany({
      where: { id: row.id, orgId: row.orgId, credentialHash: presentedHash, revokedAt: null },
      data,
    });
    if (saved.count === 0 && data.credentialHash) {
      this.logger.log(`Airtable credential ${row.id}: a newer refresh token was already stored`);
    }

    this.accessTokens.set(row.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    return tokens.accessToken;
  }

  /** active -> invalid, audited once. A connection that is already parked stays as it is. */
  private async markInvalid(row: { id: string; orgId: string }, code: string): Promise<void> {
    this.accessTokens.delete(row.id);
    const brokenAt = new Date();
    const changed = await this.prisma.integration.updateMany({
      where: { id: row.id, orgId: row.orgId, status: IntegrationStatus.active },
      data: { status: IntegrationStatus.invalid, lastErrorAt: brokenAt, lastErrorCode: code },
    });
    if (changed.count === 0) return;
    this.connectionAlerts.connectionBroken({
      orgId: row.orgId,
      connectionId: row.id,
      providerLabel: 'Airtable',
      impact: 'Leads are not syncing with Airtable.',
      reconnectPath: '/integrations',
      brokenAt,
    });
    this.logger.warn(`Airtable credential ${row.id} needs reauthorization (${code})`);
    await this.audit.record({
      orgId: row.orgId,
      actorType: 'system',
      action: 'airtable.reauthorization_required',
      entityType: 'integration',
      entityId: row.id,
      payload: { code },
    });
  }

  private decrypt(row: { id: string; orgId: string; credentials: string }): string {
    return this.secrets.open(row.credentials, aad.integration(row.orgId, row.id));
  }

  /**
   * Seals a webhook's MAC secret to the lead source it belongs to. Airtable
   * returns that secret exactly once, at creation, so it is sealed immediately
   * or lost — and the AAD means the ciphertext cannot be moved to another
   * source's row to make its signatures verify.
   */
  sealForSource(orgId: string, sourceId: string, secret: string): string {
    return this.secrets.seal(secret, aad.signingSecret(orgId, sourceId));
  }

  /** The webhook MAC secret for a source; null when it cannot be opened. */
  openForSource(orgId: string, sourceId: string, sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      return this.secrets.open(sealed, aad.signingSecret(orgId, sourceId));
    } catch {
      return null;
    }
  }

  /** Airtable failures in the API's error envelope. Never 401: the SPA reads a 401 as "your session ended". */
  toHttp(e: unknown): unknown {
    if (!(e instanceof AirtableApiError)) return e;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return httpError(409, 'AIRTABLE_REAUTH_REQUIRED', 'Airtable access was revoked or has expired. Reconnect Airtable to continue.');
      case 'SCOPE_MISSING':
        return httpError(403, 'AIRTABLE_SCOPE_NOT_GRANTED', 'Airtable did not grant this permission. Reconnect Airtable and approve it.');
      case 'RATE_LIMITED':
        return httpError(429, 'AIRTABLE_RATE_LIMITED', 'Airtable is rate-limiting requests. Try again in a minute.');
      case 'UNAVAILABLE':
        return httpError(502, 'AIRTABLE_UNAVAILABLE', 'Airtable did not respond. Try again shortly.');
      case 'NOT_FOUND':
        return httpError(404, 'AIRTABLE_NOT_FOUND', `Airtable could not find that: ${e.message}`);
      default:
        return httpError(502, 'AIRTABLE_REQUEST_FAILED', `Airtable refused the request: ${e.message}`);
    }
  }
}

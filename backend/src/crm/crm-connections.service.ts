import { Injectable, Logger } from '@nestjs/common';
import { ConnectionAlertService } from '@/common/service/connection-alert.service';
import {
  ConnectionMethod,
  ConsentStatus,
  CrmSyncRunKind,
  CrmSyncRunStatus,
  IngestStatus,
  IntegrationProvider,
  IntegrationStatus,
  LeadSourceProvider,
  MappingStatus,
  Prisma,
  QueueState,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { lockOrganization } from '@/calendar/connection/calendar-access.service';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, sha256Hex } from '@/common/utils/crypto';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { openState, sealState } from '@/google-sheets/oauth-state';
import { CrmApiError, type CrmAdapter, type CrmTokens } from './types';

export type { SessionIdentity };

/**
 * A CRM account connected to an organization: the OAuth flow, the stored grant,
 * access tokens, and disconnect.
 *
 * Where things live (see migration 20261016000002_crm_hubspot_sync):
 *  - the grant: an integrations row (provider 'hubspot'). The refresh token is
 *    sealed to (organization, row id), opened only here, and never returned,
 *    logged or put in an error. Access tokens live in process memory only.
 *  - the connection's import: lead_sources (connection_method 'SYNC',
 *    external_form_id = the CRM account id). Its leads point at it.
 *  - an authorization in flight: a sealed state, as for Google, single-use.
 *
 * Policy: one live CRM account per organization, and a CRM account live in at
 * most one organization. Both are partial unique indexes.
 */

/** Binds a CRM OAuth state to the CRM flow, so a Google state cannot complete it (and the reverse). */
const CRM_STATE_AAD = 'crm:oauth_state:v1';
/** For the two interactive transactions here; short enough that a stuck one still fails visibly. */
const TX_LIMITS = { maxWait: 10_000, timeout: 20_000 } as const;
/** Refresh this long before the CRM's expiry, so a token never dies mid-page. */
const EARLY_REFRESH_MS = 5 * 60 * 1000;

/** The integrations.provider value a CRM adapter's grant is stored under. */
export function integrationProviderOf(adapter: CrmAdapter): IntegrationProvider {
  if (adapter.provider === LeadSourceProvider.HUBSPOT) return IntegrationProvider.hubspot;
  throw new Error(`No integration provider for CRM ${adapter.provider}`);
}

/** The lead_sources.provider value of a CRM adapter's import. */
export function sourceProviderOf(adapter: CrmAdapter): LeadSourceProvider {
  if (adapter.provider === LeadSourceProvider.HUBSPOT) return LeadSourceProvider.HUBSPOT;
  throw new Error(`No lead source provider for CRM ${adapter.provider}`);
}

/** A 403 REAUTH is the CRM refusing a scope it was not granted; anything else is a dead grant. */
const reauthCode = (e: CrmApiError) => (e.status === 403 ? 'CRM_SCOPE_NOT_GRANTED' : 'CRM_REAUTH_REQUIRED');

/** Thrown inside the connect transaction so the caller can hand back what the CRM just issued. */
class AccountConflict extends Error {
  constructor(readonly accountName: string | null) {
    super('account conflict');
  }
}

/** Selected so the ciphertext can never ride along into a DTO by accident. */
const CREDENTIAL_ROW = { id: true, orgId: true, credentials: true, credentialHash: true, status: true } as const;
type CredentialRow = { id: string; orgId: string; credentials: string; credentialHash: string | null; status: IntegrationStatus };

@Injectable()
export class CrmConnectionsService {
  private readonly logger = new Logger('CrmConnections');
  /** credential id -> access token. Memory only, by design. */
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  /** credential id -> the refresh in flight: concurrent callers share one refresh instead of racing. */
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly audit: AuditService,
    private readonly connectionAlerts: ConnectionAlertService,
  ) {}

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  start(adapter: CrmAdapter, who: SessionIdentity): { authorizeUrl: string; state: string } {
    if (!adapter.isConfigured()) {
      throw httpError(400, 'CRM_NOT_CONFIGURED', `${adapter.label.displayName} is not configured on this server. Set its client id and secret.`);
    }
    const { state } = sealState(this.secrets, who, Date.now(), `${CRM_STATE_AAD}:${adapter.provider}`);
    return { authorizeUrl: adapter.authorizeUrl(state), state };
  }

  /** Finish an authorization on the session that started it, once. */
  async complete(adapter: CrmAdapter, who: SessionIdentity, code: string, state: string) {
    this.consumeState(adapter, who, state);

    let tokens: CrmTokens;
    try {
      tokens = await adapter.exchangeCode(code);
    } catch (e) {
      if (e instanceof CrmApiError && e.kind === 'REAUTH') {
        throw httpError(400, 'OAUTH_CODE_REJECTED', `${adapter.label.displayName} rejected the authorization code. Start the connection again.`);
      }
      throw this.toHttp(adapter, e);
    }
    if (!tokens.refreshToken) {
      throw httpError(502, 'CRM_NO_REFRESH_TOKEN', `${adapter.label.displayName} did not issue a long-lived token. Try connecting again.`);
    }
    const refreshToken = tokens.refreshToken;

    // From here the CRM has issued a live grant. Any refusal hands it back.
    const refuse = async (status: number, errCode: string, message: string) => {
      await this.revokeUnlessLive(adapter, refreshToken);
      return httpError(status, errCode, message);
    };

    let account;
    try {
      account = await adapter.identify(tokens.accessToken);
    } catch {
      throw await refuse(502, 'CRM_IDENTITY_MISSING', `${adapter.label.displayName} did not say which account was connected. Try again.`);
    }
    const granted = new Set([...(account.scopes ?? []), ...(tokens.scopes ?? [])]);
    const missing = adapter.requiredScopes.filter((s) => !granted.has(s));
    if (missing.length) {
      throw await refuse(
        400,
        'CRM_SCOPE_NOT_GRANTED',
        `${adapter.label.displayName} did not grant ${missing.join(', ')}. Connect again and approve every requested permission.`,
      );
    }

    const integrationProvider = integrationProviderOf(adapter);
    const sourceProvider = sourceProviderOf(adapter);
    let result: { credentialId: string; sourceId: string; runId: string | null; reconnected: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Serialises completions for one organization: two tabs finishing at once must not both pass the one-account check.
        await lockOrganization(tx, who.organizationId);

        const live = await tx.integration.findMany({
          where: { orgId: who.organizationId, provider: integrationProvider, revokedAt: null },
          select: { id: true, externalAccountId: true, accountName: true },
        });
        const other = live.find((c) => c.externalAccountId !== account.externalAccountId);
        if (other) throw new AccountConflict(other.accountName);
        const existing = live.find((c) => c.externalAccountId === account.externalAccountId);

        // The id exists before sealing: the AAD binds the ciphertext to its row.
        const credentialId = existing?.id ?? randomUUID();
        const data = {
          credentials: this.secrets.seal(refreshToken, aad.integration(who.organizationId, credentialId)),
          credentialHash: sha256Hex(refreshToken),
          credentialPreview: 'oauth',
          label: account.accountName ?? account.externalAccountId,
          accountName: account.accountName,
          accountEmail: account.userEmail,
          externalAccountId: account.externalAccountId,
          status: IntegrationStatus.active,
          lastVerifiedAt: new Date(),
          lastErrorAt: null,
          lastErrorCode: null,
        };
        if (existing) await tx.integration.update({ where: { id: credentialId }, data });
        else await tx.integration.create({ data: { id: credentialId, orgId: who.organizationId, provider: integrationProvider, ...data } });

        // The import source for this account: reused on a reconnect, so its tracked records — and their leads — carry on.
        const name = `${adapter.label.displayName} · ${account.accountName ?? account.externalAccountId}`.slice(0, 100);
        const prior = await tx.leadSource.findFirst({
          where: {
            orgId: who.organizationId,
            provider: sourceProvider,
            connectionMethod: ConnectionMethod.SYNC,
            externalFormId: account.externalAccountId,
            archivedAt: null,
          },
          select: { id: true, remoteSyncedAt: true },
        });
        const sourceId = prior?.id ?? randomUUID();
        const sourceState = {
          integrationId: credentialId,
          isActive: true,
          ingestStatus: IngestStatus.ACTIVE,
          mappingStatus: MappingStatus.CONFIGURED,
          externalFormName: account.accountName,
          remoteErrorCode: null,
          remoteErrorMessage: null,
          syncFailures: 0,
        };
        if (prior) {
          await tx.leadSource.update({ where: { id: sourceId }, data: { ...sourceState, name } });
        } else {
          await tx.leadSource.create({
            data: {
              id: sourceId,
              orgId: who.organizationId,
              name,
              code: `${adapter.provider.toLowerCase()}-${account.externalAccountId}`.slice(0, 50),
              provider: sourceProvider,
              connectionMethod: ConnectionMethod.SYNC,
              externalFormId: account.externalAccountId,
              // Never from the CRM: no consent basis is asserted for imported contacts.
              defaultConsentStatus: ConsentStatus.pending,
              ...sourceState,
            },
          });
        }

        // The first import, or on a reconnect a complete re-read. Never a second one: the partial unique index makes a duplicate a no-op.
        const runId = randomUUID();
        const queued = await tx.crmSyncRun.createMany({
          data: [
            {
              id: runId,
              orgId: who.organizationId,
              leadSourceId: sourceId,
              provider: sourceProvider,
              kind: prior?.remoteSyncedAt ? CrmSyncRunKind.full : CrmSyncRunKind.initial,
              requestedBy: who.userId,
            },
          ],
          skipDuplicates: true,
        });

        await this.audit.record(
          {
            orgId: who.organizationId,
            actorType: 'user',
            actorId: who.userId,
            action: existing || prior ? 'crm.reconnected' : 'crm.connected',
            entityType: 'integration',
            entityId: credentialId,
            payload: {
              provider: adapter.provider,
              accountId: account.externalAccountId,
              accountName: account.accountName,
              authorizedBy: account.userEmail,
              scopes: [...granted].sort(),
              leadSourceId: sourceId,
              runId: queued.count ? runId : null,
            },
          },
          tx,
        );
        return { credentialId, sourceId, runId: queued.count ? runId : null, reconnected: Boolean(existing || prior) };
      }, TX_LIMITS);
    } catch (e) {
      if (e instanceof AccountConflict) {
        throw await refuse(
          409,
          'CRM_ACCOUNT_CONFLICT',
          `This organization is already connected to ${e.accountName ?? `another ${adapter.label.displayName} account`}. Disconnect it first to use a different account.`,
        );
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // integrations_hubspot_account_live: this CRM account is live in another organization. Which one is not said.
        throw await refuse(
          409,
          'CRM_ACCOUNT_IN_USE',
          `This ${adapter.label.displayName} account is already connected to another EstatePulse organization. It must be disconnected there first.`,
        );
      }
      await this.revokeUnlessLive(adapter, refreshToken);
      throw e;
    }

    this.accessTokens.set(result.credentialId, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    this.logger.log(`${adapter.provider} connected for organization ${who.organizationId} (credential ${result.credentialId})`);
    return result;
  }

  /** The state must come back to the same session that started it, unexpired, once. */
  private consumeState(adapter: CrmAdapter, who: SessionIdentity, state: string): void {
    const name = adapter.label.displayName;
    const p = openState(this.secrets, state, `${CRM_STATE_AAD}:${adapter.provider}`);
    if (!p) throw httpError(400, 'OAUTH_STATE_INVALID', `This ${name} authorization is not valid. Start the connection again.`);
    if (p.exp < Date.now()) throw httpError(400, 'OAUTH_STATE_EXPIRED', `This ${name} authorization expired. Start the connection again.`);
    if (p.org !== who.organizationId || p.usr !== who.userId || p.sid !== who.sessionId) {
      throw httpError(403, 'OAUTH_SESSION_MISMATCH', `This ${name} authorization was started from a different session. Start it again from this window.`);
    }
    const now = Date.now();
    for (const [n, e] of this.usedNonces) if (e < now) this.usedNonces.delete(n);
    if (this.usedNonces.has(p.nonce)) {
      throw httpError(400, 'OAUTH_STATE_USED', `This ${name} authorization was already used. Start the connection again.`);
    }
    this.usedNonces.set(p.nonce, p.exp);
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  /**
   * Stop syncing, forget the grant, keep the data. Local state changes first,
   * in one transaction, so disconnect succeeds even when the CRM is down; then,
   * best effort, the app is uninstalled from the CRM account and the refresh
   * token revoked. Imported leads and their tracking rows are untouched: a
   * reconnect of the same account picks them straight back up.
   */
  async disconnect(adapter: CrmAdapter, who: SessionIdentity): Promise<{ disconnected: true }> {
    const integrationProvider = integrationProviderOf(adapter);
    const sourceProvider = sourceProviderOf(adapter);
    const cred = await this.prisma.integration.findFirst({
      where: { orgId: who.organizationId, provider: integrationProvider, revokedAt: null },
      select: CREDENTIAL_ROW,
    });
    if (!cred) throw httpError(404, 'CRM_NOT_CONNECTED', `${adapter.label.displayName} is not connected.`);

    let refreshToken: string | null = null;
    try {
      refreshToken = cred.credentials ? this.decrypt(cred) : null;
    } catch (e) {
      this.logger.warn(`${adapter.provider} credential ${cred.id} could not be decrypted for revocation: ${(e as Error).message}`);
    }

    await this.prisma.$transaction(async (tx) => {
      const sources = await tx.leadSource.findMany({
        where: { orgId: who.organizationId, provider: sourceProvider, integrationId: cred.id },
        select: { id: true },
      });
      const sourceIds = sources.map((s) => s.id);
      await tx.integration.update({
        where: { id: cred.id },
        data: { status: IntegrationStatus.revoked, revokedAt: new Date(), credentials: '' },
      });
      if (sourceIds.length) {
        await tx.leadSource.updateMany({
          where: { orgId: who.organizationId, id: { in: sourceIds } },
          data: { isActive: false, ingestStatus: IngestStatus.PAUSED, syncNextAt: null },
        });
        await tx.crmSyncRun.updateMany({
          where: { orgId: who.organizationId, leadSourceId: { in: sourceIds }, status: { in: [CrmSyncRunStatus.queued, CrmSyncRunStatus.running] } },
          data: {
            status: CrmSyncRunStatus.cancelled,
            finishedAt: new Date(),
            errorCode: 'DISCONNECTED',
            errorMessage: `${adapter.label.displayName} was disconnected.`,
          },
        });
        await tx.ingestEvent.updateMany({
          where: {
            orgId: who.organizationId,
            leadSourceId: { in: sourceIds },
            provider: sourceProvider,
            queueState: { in: [QueueState.PENDING, QueueState.PROCESSING] },
          },
          data: { queueState: QueueState.DONE, outcomeReason: 'disconnected', processedAt: new Date(), lockedAt: null, lockedBy: null },
        });
      }
      await this.audit.record(
        {
          orgId: who.organizationId,
          actorType: 'user',
          actorId: who.userId,
          action: 'crm.disconnected',
          entityType: 'integration',
          entityId: cred.id,
          payload: { provider: adapter.provider, leadSourceIds: sourceIds },
        },
        tx,
      );
    }, TX_LIMITS);
    this.accessTokens.delete(cred.id);

    if (refreshToken) {
      try {
        const tokens = await adapter.refresh(refreshToken);
        await adapter.uninstall(tokens.accessToken);
      } catch (e) {
        this.logger.warn(`${adapter.provider} uninstall skipped for credential ${cred.id}: ${(e as Error).message}`);
      }
      try {
        await adapter.revoke(refreshToken);
      } catch (e) {
        this.logger.warn(`${adapter.provider} revoke skipped for credential ${cred.id}: ${(e as Error).message}`);
      }
    }
    return { disconnected: true };
  }

  // -------------------------------------------------------------------------
  // Access tokens
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` with a valid access token for this credential. A 401 drops the
   * cached token and retries once on a fresh one. A second 401, a dead refresh
   * token, or a call refused for a missing scope parks the connection (invalid)
   * and surfaces as REAUTH, which no caller retries.
   */
  async withAccessToken<T>(adapter: CrmAdapter, organizationId: string, credentialId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    const row = await this.loadCredential(adapter, organizationId, credentialId);
    try {
      return await fn(await this.accessToken(adapter, row));
    } catch (e) {
      if (e instanceof CrmApiError && e.kind === 'REAUTH') await this.markInvalid(adapter, row, reauthCode(e));
      if (!(e instanceof CrmApiError && e.kind === 'UNAUTHORIZED')) throw e;
    }
    this.accessTokens.delete(row.id);
    try {
      return await fn(await this.accessToken(adapter, row));
    } catch (e) {
      if (e instanceof CrmApiError && e.kind === 'UNAUTHORIZED') {
        await this.markInvalid(adapter, row, 'CRM_REAUTH_REQUIRED');
        throw new CrmApiError('REAUTH', `${adapter.label.displayName} refused a freshly issued token`, 401);
      }
      if (e instanceof CrmApiError && e.kind === 'REAUTH') await this.markInvalid(adapter, row, reauthCode(e));
      throw e;
    }
  }

  private async loadCredential(adapter: CrmAdapter, organizationId: string, credentialId: string): Promise<CredentialRow> {
    // An undefined id would drop the filter and match any row in the organization.
    if (!credentialId) throw new CrmApiError('REAUTH', 'No connection', 0);
    const row = await this.prisma.integration.findFirst({
      where: { id: credentialId, orgId: organizationId, provider: integrationProviderOf(adapter), revokedAt: null },
      select: CREDENTIAL_ROW,
    });
    if (!row) throw new CrmApiError('REAUTH', `${adapter.label.displayName} was disconnected`, 0);
    if (row.status !== IntegrationStatus.active) throw new CrmApiError('REAUTH', `${adapter.label.displayName} needs to be reconnected`, 0);
    return row;
  }

  private accessToken(adapter: CrmAdapter, row: CredentialRow): Promise<string> {
    const cached = this.accessTokens.get(row.id);
    if (cached && cached.expiresAt - EARLY_REFRESH_MS > Date.now()) return Promise.resolve(cached.token);
    let inFlight = this.refreshing.get(row.id);
    if (!inFlight) {
      inFlight = this.refreshNow(adapter, row).finally(() => this.refreshing.delete(row.id));
      this.refreshing.set(row.id, inFlight);
    }
    return inFlight;
  }

  /**
   * One refresh, safe with several API instances: a rejected refresh token is
   * re-read before giving up (another instance may have rotated it), and a
   * rotated token is stored with a compare-and-swap on the hash of the token
   * that was presented, so a stale instance never overwrites a newer one.
   */
  private async refreshNow(adapter: CrmAdapter, row: CredentialRow): Promise<string> {
    let presented = this.decrypt(row);
    let presentedHash = row.credentialHash;
    let tokens: CrmTokens;
    try {
      tokens = await adapter.refresh(presented);
    } catch (e) {
      if (!(e instanceof CrmApiError && e.kind === 'REAUTH')) throw e;
      const latest = await this.prisma.integration.findFirst({
        where: { id: row.id, orgId: row.orgId, revokedAt: null },
        select: CREDENTIAL_ROW,
      });
      if (!latest || latest.status !== IntegrationStatus.active || latest.credentialHash === row.credentialHash) {
        await this.markInvalid(adapter, row, 'CRM_REAUTH_REQUIRED');
        throw e;
      }
      presented = this.decrypt(latest);
      presentedHash = latest.credentialHash;
      try {
        tokens = await adapter.refresh(presented);
      } catch (again) {
        if (again instanceof CrmApiError && again.kind === 'REAUTH') await this.markInvalid(adapter, latest, 'CRM_REAUTH_REQUIRED');
        throw again;
      }
    }

    // An owner can withdraw a permission in the CRM without revoking the grant.
    if (tokens.scopes && adapter.requiredScopes.some((s) => !tokens.scopes!.includes(s))) {
      await this.markInvalid(adapter, row, 'CRM_SCOPE_NOT_GRANTED');
      throw new CrmApiError('REAUTH', `${adapter.label.displayName} no longer grants a required permission`, 403);
    }

    const data: Prisma.IntegrationUpdateManyMutationInput = { lastVerifiedAt: new Date() };
    if (tokens.refreshToken && tokens.refreshToken !== presented) {
      data.credentials = this.secrets.seal(tokens.refreshToken, aad.integration(row.orgId, row.id));
      data.credentialHash = sha256Hex(tokens.refreshToken);
    }
    const saved = await this.prisma.integration.updateMany({
      where: { id: row.id, orgId: row.orgId, credentialHash: presentedHash, revokedAt: null },
      data,
    });
    if (saved.count === 0 && data.credentialHash) {
      this.logger.log(`${adapter.provider} credential ${row.id}: a newer refresh token was already stored`);
    }

    this.accessTokens.set(row.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    return tokens.accessToken;
  }

  /** active -> invalid, audited once. A connection that is already parked stays as it is. */
  private async markInvalid(adapter: CrmAdapter, row: { id: string; orgId: string }, code: string): Promise<void> {
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
      providerLabel: adapter.label.displayName,
      impact: `Leads are not syncing to ${adapter.label.displayName}.`,
      reconnectPath: '/integrations',
      brokenAt,
    });
    this.logger.warn(`${adapter.provider} credential ${row.id} needs reauthorization (${code})`);
    await this.audit.record({
      orgId: row.orgId,
      actorType: 'system',
      action: 'crm.reauthorization_required',
      entityType: 'integration',
      entityId: row.id,
      payload: { provider: adapter.provider, code },
    });
  }

  /** Hands a grant back to the CRM unless some live connection is still using it. */
  private async revokeUnlessLive(adapter: CrmAdapter, refreshToken: string): Promise<void> {
    try {
      const live = await this.prisma.integration.count({
        where: { provider: integrationProviderOf(adapter), credentialHash: sha256Hex(refreshToken), revokedAt: null },
      });
      if (live > 0) return;
      await adapter.revoke(refreshToken);
    } catch (e) {
      this.logger.warn(`${adapter.provider} revoke failed: ${(e as Error).message}`);
    }
  }

  private decrypt(row: { id: string; orgId: string; credentials: string }): string {
    return this.secrets.open(row.credentials, aad.integration(row.orgId, row.id));
  }

  /** CRM failures in the API's error envelope. Never 401: the SPA reads a 401 as "your session ended". */
  toHttp(adapter: CrmAdapter, e: unknown): unknown {
    if (!(e instanceof CrmApiError)) return e;
    const name = adapter.label.displayName;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return httpError(409, 'CRM_REAUTH_REQUIRED', `${name} access was revoked or has expired. Reconnect ${name} to continue.`);
      case 'RATE_LIMITED':
        return httpError(429, 'CRM_RATE_LIMITED', `${name} is rate-limiting requests. Try again in a minute.`);
      case 'UNAVAILABLE':
        return httpError(502, 'CRM_UNAVAILABLE', `${name} did not respond. Try again shortly.`);
      default:
        return httpError(502, 'CRM_REQUEST_FAILED', `${name} refused the request: ${e.message}`);
    }
  }
}

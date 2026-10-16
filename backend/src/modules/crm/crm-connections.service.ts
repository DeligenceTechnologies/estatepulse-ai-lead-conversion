import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { SecretBox, providerCredentialAad, sha256Hex } from '../../common/crypto';
import { CredentialStatus, IngestStatus, MappingStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { SYNC_CONNECTION } from '../google-sheets/sheet-import.service';
import { CrmApiError, type CrmAdapter, type CrmTokens } from './types';

/**
 * A CRM account connected to an organization: the OAuth flow, the stored grant,
 * access tokens, and disconnect.
 *
 * Where things live (see migration 20261015000001_crm_hubspot_sync):
 *  - the grant: provider_credentials (provider 'HUBSPOT'). The refresh token is
 *    a SecretBox envelope bound to (organization, row id), decrypted only here,
 *    and never returned, logged or put in an error. Access tokens live in
 *    process memory until they expire and are never persisted.
 *  - the connection's import: lead_sources (connection_method 'SYNC',
 *    external_form_id = the CRM account id). Its leads point at it.
 *  - an authorization in flight: oauth_states, by sha256 of the state.
 *
 * Policy: one live CRM account per organization, and a CRM account live in at
 * most one organization. Both are partial unique indexes, so they hold however
 * two completions interleave.
 */

export interface SessionIdentity {
  organizationId: string;
  userId: string;
  sessionId: string;
}

/** Long enough to read a consent screen, short enough that a leaked state dies fast. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/**
 * For the two interactive transactions here. Prisma's defaults (2 s to get a
 * connection, 5 s to finish) are tight while a large import is using the pool;
 * these stay short enough that a stuck one still fails visibly.
 */
const TX_LIMITS = { maxWait: 10_000, timeout: 20_000 } as const;
/** Refresh this long before HubSpot's expiry, so a token never dies mid-page. */
const EARLY_REFRESH_MS = 5 * 60 * 1000;

const fail = (status: number, code: string, message: string) => new HttpException({ error: { code, message } }, status);

/** A 403 REAUTH is the CRM refusing a scope it was not granted; anything else is a dead grant. */
const reauthCode = (e: CrmApiError) => (e.status === 403 ? 'CRM_SCOPE_NOT_GRANTED' : 'CRM_REAUTH_REQUIRED');

/** Thrown inside the connect transaction so the caller can hand back what the CRM just issued. */
class AccountConflict extends Error {
  constructor(readonly accountName: string | null) {
    super('account conflict');
  }
}

/** Selected so credential_enc can never ride along into a DTO by accident. */
const CREDENTIAL_ROW = { id: true, organization_id: true, credential_enc: true, credential_hash: true, status: true } as const;
type CredentialRow = { id: string; organization_id: string; credential_enc: string; credential_hash: string; status: string };

@Injectable()
export class CrmConnectionsService {
  private readonly logger = new Logger('CrmConnections');
  private readonly box: SecretBox;
  /** credential id -> access token. Memory only, by design. */
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  /** credential id -> the refresh in flight: concurrent callers share one refresh instead of racing. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    // Unguarded on purpose, for one question only: is this refresh token live in
    // ANY organization? Asked before handing a token back to the CRM, so a
    // refusal can never revoke a grant some other connection is still using.
    private readonly unscoped: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.box = new SecretBox(this.config.getOrThrow<string>('ENCRYPTION_KEYS'), this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'));
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  async start(adapter: CrmAdapter, who: SessionIdentity): Promise<{ authorizeUrl: string; state: string }> {
    if (!adapter.isConfigured()) {
      throw fail(400, 'CRM_NOT_CONFIGURED', `${adapter.label.displayName} is not configured on this server. Set its client id and secret.`);
    }
    const state = randomBytes(32).toString('base64url');
    await this.prisma.oauth_states.create({
      data: {
        id: sha256Hex(state),
        provider: adapter.provider,
        organization_id: who.organizationId,
        user_id: who.userId,
        session_id: who.sessionId,
        expires_at: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    // Housekeeping, bounded by the expiry index. Raw because it is not about
    // one organization: an expired state is worthless to everyone.
    await this.unscoped.$executeRaw`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`;
    return { authorizeUrl: adapter.authorizeUrl(state), state };
  }

  /**
   * Finish an authorization on the session that started it.
   *
   * Runs behind SessionGuard and OwnerGuard, which re-read the caller's
   * membership and role from the database on this request: someone demoted or
   * removed while the consent screen was open cannot complete it.
   */
  async complete(adapter: CrmAdapter, who: SessionIdentity, code: string, state: string) {
    await this.consumeState(adapter, who, state);

    let tokens: CrmTokens;
    try {
      tokens = await adapter.exchangeCode(code);
    } catch (e) {
      if (e instanceof CrmApiError && e.kind === 'REAUTH') {
        throw fail(400, 'OAUTH_CODE_REJECTED', `${adapter.label.displayName} rejected the authorization code. Start the connection again.`);
      }
      throw this.toHttp(adapter, e);
    }
    if (!tokens.refreshToken) {
      throw fail(502, 'CRM_NO_REFRESH_TOKEN', `${adapter.label.displayName} did not issue a long-lived token. Try connecting again.`);
    }
    const refreshToken = tokens.refreshToken;

    // From here the CRM has issued a live grant. Any refusal hands it back, so
    // a grant we are not going to keep never lingers on the account.
    const refuse = async (status: number, errCode: string, message: string) => {
      await this.revokeUnlessLive(adapter, refreshToken);
      return fail(status, errCode, message);
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

    let result: { credentialId: string; sourceId: string; runId: string | null; reconnected: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Serialises completions for one organization: two tabs finishing at
        // once must not both pass the one-account check.
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${who.organizationId}::uuid FOR UPDATE`;

        const live = await tx.provider_credentials.findMany({
          where: { organization_id: who.organizationId, provider: adapter.provider, revoked_at: null },
          select: { id: true, external_account_id: true, account_name: true },
        });
        const other = live.find((c) => c.external_account_id !== account.externalAccountId);
        if (other) throw new AccountConflict(other.account_name);
        const existing = live.find((c) => c.external_account_id === account.externalAccountId);

        // The id exists before encrypting: the AAD binds the ciphertext to its row.
        const credentialId = existing?.id ?? newId();
        const data = {
          credential_enc: this.box.encrypt(refreshToken, providerCredentialAad(who.organizationId, credentialId)),
          credential_hash: sha256Hex(refreshToken),
          label: account.accountName ?? account.externalAccountId,
          account_name: account.accountName,
          account_email: account.userEmail,
          external_account_id: account.externalAccountId,
          status: CredentialStatus.ACTIVE,
          last_verified_at: new Date(),
          last_error_at: null,
          last_error_code: null,
          updated_at: new Date(),
        };
        if (existing) {
          await tx.provider_credentials.update({ where: { id: credentialId }, data });
        } else {
          await tx.provider_credentials.create({
            data: {
              id: credentialId,
              organization_id: who.organizationId,
              provider: adapter.provider,
              // NOT NULL columns built for API keys; an OAuth grant has no display fragment.
              credential_prefix: 'oauth',
              credential_last4: '',
              ...data,
            },
          });
        }

        // The import source for this account: reused on a reconnect, so its
        // tracked records — and therefore its leads — carry straight on.
        const name = `${adapter.label.displayName} · ${account.accountName ?? account.externalAccountId}`.slice(0, 100);
        const prior = await tx.lead_sources.findFirst({
          where: {
            organization_id: who.organizationId,
            provider: adapter.provider,
            connection_method: SYNC_CONNECTION,
            external_form_id: account.externalAccountId,
            archived_at: null,
          },
          select: { id: true, remote_synced_at: true },
        });
        const sourceId = prior?.id ?? newId();
        const sourceState = {
          provider_credential_id: credentialId,
          is_active: true,
          ingest_status: IngestStatus.ACTIVE,
          mapping_status: MappingStatus.CONFIGURED,
          external_form_name: account.accountName,
          remote_error_code: null,
          remote_error_message: null,
          sync_failures: 0,
          updated_at: new Date(),
        };
        if (prior) {
          await tx.lead_sources.update({ where: { id: sourceId }, data: { ...sourceState, name } });
        } else {
          await tx.lead_sources.create({
            data: {
              id: sourceId,
              organization_id: who.organizationId,
              name,
              code: `${adapter.provider.toLowerCase()}-${account.externalAccountId}`.slice(0, 50),
              source_type: 'other',
              provider: adapter.provider,
              connection_method: SYNC_CONNECTION,
              external_form_id: account.externalAccountId,
              // Never from the CRM: no consent basis is asserted for imported contacts.
              default_consent_status: 'pending',
              ...sourceState,
            },
          });
        }

        // The first import, or — on a reconnect — a complete re-read to catch
        // whatever changed while it was disconnected. Never a second one: the
        // partial unique index turns a duplicate into a no-op.
        const runId = newId();
        const queued = await tx.crm_sync_runs.createMany({
          data: [
            {
              id: runId,
              organization_id: who.organizationId,
              lead_source_id: sourceId,
              provider: adapter.provider,
              kind: prior?.remote_synced_at ? 'full' : 'initial',
              requested_by: who.userId,
            },
          ],
          skipDuplicates: true,
        });

        await tx.audit_logs.create({
          data: {
            id: newId(),
            organization_id: who.organizationId,
            actor_type: 'user',
            actor_id: who.userId,
            action: existing || prior ? 'crm.reconnected' : 'crm.connected',
            entity_type: 'provider_credential',
            entity_id: credentialId,
            payload: {
              provider: adapter.provider,
              accountId: account.externalAccountId,
              accountName: account.accountName,
              authorizedBy: account.userEmail,
              scopes: [...granted].sort(),
              leadSourceId: sourceId,
              runId: queued.count ? runId : null,
            } as Prisma.InputJsonValue,
          },
        });
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
        // provider_credentials_crm_account_live: this CRM account is live in
        // another organization. Which one is not said.
        throw await refuse(
          409,
          'CRM_ACCOUNT_IN_USE',
          `This ${adapter.label.displayName} account is already connected to another EstatePulse organization. It must be disconnected there first.`,
        );
      }
      // Nothing was stored, so nothing should stay authorized either.
      await this.revokeUnlessLive(adapter, refreshToken);
      throw e;
    }

    this.accessTokens.set(result.credentialId, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    this.logger.log(`${adapter.provider} connected for organization ${who.organizationId} (credential ${result.credentialId})`);
    return result;
  }

  /**
   * One conditional UPDATE: the state is consumed only if it is this
   * provider's, unexpired, unused, and was started by this user, in this
   * organization, on this session. Two instances (or a double submit) cannot
   * both win it. When it is refused, the row says why.
   */
  private async consumeState(adapter: CrmAdapter, who: SessionIdentity, state: string): Promise<void> {
    const id = sha256Hex(state);
    const consumed = await this.prisma.oauth_states.updateMany({
      where: {
        id,
        provider: adapter.provider,
        organization_id: who.organizationId,
        user_id: who.userId,
        session_id: who.sessionId,
        consumed_at: null,
        expires_at: { gt: new Date() },
      },
      data: { consumed_at: new Date() },
    });
    if (consumed.count === 1) return;

    const row = await this.prisma.oauth_states.findFirst({ where: { id }, select: { provider: true, organization_id: true, user_id: true, session_id: true, consumed_at: true, expires_at: true } });
    const name = adapter.label.displayName;
    if (!row || row.provider !== adapter.provider) throw fail(400, 'OAUTH_STATE_INVALID', `This ${name} authorization is not valid. Start the connection again.`);
    if (row.organization_id !== who.organizationId || row.user_id !== who.userId || row.session_id !== who.sessionId) {
      throw fail(403, 'OAUTH_SESSION_MISMATCH', `This ${name} authorization was started from a different session. Start it again from this window.`);
    }
    if (row.consumed_at) throw fail(400, 'OAUTH_STATE_USED', `This ${name} authorization was already used. Start the connection again.`);
    throw fail(400, 'OAUTH_STATE_EXPIRED', `This ${name} authorization expired. Start the connection again.`);
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  /**
   * Stop syncing, forget the grant, keep the data.
   *
   * Local state changes first, in one transaction — new runs can no longer
   * start, the active run is cancelled, queued webhook work is dropped, and the
   * ciphertext is cleared — so disconnect succeeds even when the CRM is down.
   * Then, best effort, the app is uninstalled from the CRM account (which stops
   * its webhooks) and the refresh token revoked. Imported leads, their tracking
   * rows and their history are untouched: a reconnect of the same account picks
   * them straight back up, without creating a duplicate.
   */
  async disconnect(adapter: CrmAdapter, who: SessionIdentity): Promise<{ disconnected: true }> {
    const cred = await this.prisma.provider_credentials.findFirst({
      where: { organization_id: who.organizationId, provider: adapter.provider, revoked_at: null },
      select: CREDENTIAL_ROW,
    });
    if (!cred) throw fail(404, 'CRM_NOT_CONNECTED', `${adapter.label.displayName} is not connected.`);

    let refreshToken: string | null = null;
    try {
      refreshToken = cred.credential_enc ? this.decrypt(cred) : null;
    } catch (e) {
      this.logger.warn(`${adapter.provider} credential ${cred.id} could not be decrypted for revocation: ${(e as Error).message}`);
    }

    await this.prisma.$transaction(async (tx) => {
      const sources = await tx.lead_sources.findMany({
        where: { organization_id: who.organizationId, provider: adapter.provider, provider_credential_id: cred.id },
        select: { id: true },
      });
      const sourceIds = sources.map((s) => s.id);
      await tx.provider_credentials.update({
        where: { id: cred.id },
        data: { status: CredentialStatus.REVOKED, revoked_at: new Date(), credential_enc: '', updated_at: new Date() },
      });
      if (sourceIds.length) {
        await tx.lead_sources.updateMany({
          where: { organization_id: who.organizationId, id: { in: sourceIds } },
          data: { is_active: false, ingest_status: IngestStatus.PAUSED, sync_next_at: null, updated_at: new Date() },
        });
        await tx.crm_sync_runs.updateMany({
          where: { organization_id: who.organizationId, lead_source_id: { in: sourceIds }, status: { in: ['queued', 'running'] } },
          data: {
            status: 'cancelled',
            finished_at: new Date(),
            error_code: 'DISCONNECTED',
            error_message: `${adapter.label.displayName} was disconnected.`,
            updated_at: new Date(),
          },
        });
        await tx.webhook_events.updateMany({
          where: {
            organization_id: who.organizationId,
            lead_source_id: { in: sourceIds },
            provider: adapter.provider,
            queue_state: { in: ['PENDING', 'PROCESSING'] },
          },
          data: { queue_state: 'DONE', processing_status: 'ignored', outcome_reason: 'disconnected', processed_at: new Date(), locked_at: null, locked_by: null },
        });
      }
      await tx.audit_logs.create({
        data: {
          id: newId(),
          organization_id: who.organizationId,
          actor_type: 'user',
          actor_id: who.userId,
          action: 'crm.disconnected',
          entity_type: 'provider_credential',
          entity_id: cred.id,
          payload: { provider: adapter.provider, leadSourceIds: sourceIds } as Prisma.InputJsonValue,
        },
      });
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
   * token, or a call the CRM refuses for a missing scope parks the connection
   * (INVALID) and surfaces as REAUTH, which no caller retries — and which the
   * worker's claim then skips, so a refusal cannot turn into a retry loop.
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
    const row = await this.prisma.provider_credentials.findFirst({
      where: { id: credentialId, organization_id: organizationId, provider: adapter.provider, revoked_at: null },
      select: CREDENTIAL_ROW,
    });
    if (!row) throw new CrmApiError('REAUTH', `${adapter.label.displayName} was disconnected`, 0);
    if (row.status !== CredentialStatus.ACTIVE) throw new CrmApiError('REAUTH', `${adapter.label.displayName} needs to be reconnected`, 0);
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
   * One refresh. Two things make it safe with several API instances:
   *  - if the CRM rejects the refresh token, the row is re-read before giving
   *    up: another instance may have rotated it since this one read it, and
   *    the newer token is tried once rather than the connection being parked;
   *  - a rotated refresh token is stored with a compare-and-swap on the hash of
   *    the token that was presented, so an instance holding a stale token can
   *    never overwrite a newer one.
   */
  private async refreshNow(adapter: CrmAdapter, row: CredentialRow): Promise<string> {
    let presented = this.decrypt(row);
    let presentedHash = row.credential_hash;
    let tokens: CrmTokens;
    try {
      tokens = await adapter.refresh(presented);
    } catch (e) {
      if (!(e instanceof CrmApiError && e.kind === 'REAUTH')) throw e;
      const latest = await this.prisma.provider_credentials.findFirst({
        where: { id: row.id, organization_id: row.organization_id, revoked_at: null },
        select: CREDENTIAL_ROW,
      });
      if (!latest || latest.status !== CredentialStatus.ACTIVE || latest.credential_hash === row.credential_hash) {
        await this.markInvalid(adapter, row, 'CRM_REAUTH_REQUIRED');
        throw e;
      }
      presented = this.decrypt(latest);
      presentedHash = latest.credential_hash;
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

    const data: Prisma.provider_credentialsUpdateManyMutationInput = { last_verified_at: new Date() };
    if (tokens.refreshToken && tokens.refreshToken !== presented) {
      data.credential_enc = this.box.encrypt(tokens.refreshToken, providerCredentialAad(row.organization_id, row.id));
      data.credential_hash = sha256Hex(tokens.refreshToken);
    }
    const saved = await this.prisma.provider_credentials.updateMany({
      where: { id: row.id, organization_id: row.organization_id, credential_hash: presentedHash, revoked_at: null },
      data,
    });
    if (saved.count === 0 && data.credential_hash) {
      // Someone stored a newer token first. Ours still works for now; theirs is kept.
      this.logger.log(`${adapter.provider} credential ${row.id}: a newer refresh token was already stored`);
    }

    this.accessTokens.set(row.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    return tokens.accessToken;
  }

  /** ACTIVE -> INVALID, audited once. A connection that is already parked stays as it is. */
  private async markInvalid(adapter: CrmAdapter, row: { id: string; organization_id: string }, code: string): Promise<void> {
    this.accessTokens.delete(row.id);
    const changed = await this.prisma.provider_credentials.updateMany({
      where: { id: row.id, organization_id: row.organization_id, status: CredentialStatus.ACTIVE },
      data: { status: CredentialStatus.INVALID, last_error_at: new Date(), last_error_code: code },
    });
    if (changed.count === 0) return;
    this.logger.warn(`${adapter.provider} credential ${row.id} needs reauthorization (${code})`);
    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: row.organization_id,
        actor_type: 'system',
        action: 'crm.reauthorization_required',
        entity_type: 'provider_credential',
        entity_id: row.id,
        payload: { provider: adapter.provider, code } as Prisma.InputJsonValue,
      },
    });
  }

  private async revokeUnlessLive(adapter: CrmAdapter, refreshToken: string): Promise<void> {
    try {
      const live = await this.unscoped.provider_credentials.count({
        where: { provider: adapter.provider, credential_hash: sha256Hex(refreshToken), revoked_at: null },
      });
      if (live > 0) return;
      await adapter.revoke(refreshToken);
    } catch (e) {
      this.logger.warn(`${adapter.provider} revoke failed: ${(e as Error).message}`);
    }
  }

  private decrypt(row: { id: string; organization_id: string; credential_enc: string }): string {
    return this.box.decrypt(row.credential_enc, providerCredentialAad(row.organization_id, row.id));
  }

  /**
   * CRM failures in the API's error envelope. Never 401: the SPA reads a 401 as
   * "your session ended" and signs the owner out.
   */
  toHttp(adapter: CrmAdapter, e: unknown): unknown {
    if (!(e instanceof CrmApiError)) return e;
    const name = adapter.label.displayName;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return fail(409, 'CRM_REAUTH_REQUIRED', `${name} access was revoked or has expired. Reconnect ${name} to continue.`);
      case 'RATE_LIMITED':
        return fail(429, 'CRM_RATE_LIMITED', `${name} is rate-limiting requests. Try again in a minute.`);
      case 'UNAVAILABLE':
        return fail(502, 'CRM_UNAVAILABLE', `${name} did not respond. Try again shortly.`);
      default:
        return fail(502, 'CRM_REQUEST_FAILED', `${name} refused the request: ${e.message}`);
    }
  }
}

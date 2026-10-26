import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox, providerCredentialAad, sha256Hex } from '../../common/crypto';
import { CredentialStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import {
  DRIVE_FILE_SCOPE,
  GoogleApiError,
  GoogleClient,
  SPREADSHEET_MIME,
  decodeIdToken,
} from './google.client';
import { openState, sealState } from './oauth-state';

/**
 * A Google account connected to an organization, held in `provider_credentials`.
 *
 * The refresh token is the only long-lived secret. It is stored as a SecretBox
 * envelope bound to (organization, row id), decrypted only here, and never
 * returned, logged or put in an error. Access tokens live in process memory
 * until they expire and are never persisted.
 *
 * One live Google account per organization for now (several spreadsheets and
 * tabs under it). Reconnecting the same account refreshes its row in place;
 * connecting a different one is refused until the first is disconnected.
 */

/** provider_credentials.provider for these rows. Not a form provider — see IntegrationsService. */
export const GOOGLE_PROVIDER = 'GOOGLE';

const SAMPLE_ROWS = 5;
const SAMPLE_COLUMNS = 6;

export interface SessionIdentity {
  organizationId: string;
  userId: string;
  sessionId: string;
}

export interface GoogleConnectionDTO {
  id: string;
  accountEmail: string | null;
  /** ACTIVE | INVALID (reconnect needed) */
  status: string;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  connectedAt: Date;
}

export interface SpreadsheetInspectionDTO {
  spreadsheetId: string;
  title: string;
  /** Drive's file version and modified time — recorded now to evaluate change detection later. */
  version: string | null;
  modifiedTime: string | null;
  tabs: { sheetId: number; title: string; index: number; rowCount: number | null; columnCount: number | null }[];
  sample: { sheetId: number; title: string; rows: string[][] } | null;
}

/** Selected so credential_enc can never ride along into a DTO by accident. */
const CONNECTION_SELECT = {
  id: true,
  account_email: true,
  status: true,
  last_verified_at: true,
  last_error_code: true,
  created_at: true,
} as const;

const fail = (status: number, code: string, message: string) => new HttpException({ error: { code, message } }, status);

/** Thrown inside the connect transaction so the caller can revoke what Google just issued. */
class AccountConflict extends Error {
  constructor(readonly email: string | null) {
    super('account conflict');
  }
}

@Injectable()
export class GoogleConnectionsService {
  private readonly logger = new Logger(GoogleConnectionsService.name);
  private readonly box: SecretBox;
  /** credential id -> access token. Memory only, by design. */
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  /**
   * State nonces already spent, until they would have expired anyway.
   *
   * ponytail: per-process. A second API instance could accept one replay of a
   * state within its ten-minute life; it would still need the same user's
   * session, and Google's single-use code plus the PKCE binding stop the
   * exchange. Move to a table if this ever runs on several instances.
   */
  private readonly usedNonces = new Map<string, number>();

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly config: ConfigService,
    private readonly google: GoogleClient,
  ) {
    this.box = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  /** What the browser needs to show the Google Picker. Nothing here is secret. */
  publicConfig() {
    const configured = this.google.isConfigured();
    return {
      configured,
      clientId: configured ? this.google.clientId : null,
      ...this.google.pickerConfig(),
      scope: DRIVE_FILE_SCOPE,
    };
  }

  start(who: SessionIdentity): { authorizeUrl: string; state: string } {
    if (!this.google.isConfigured()) {
      throw fail(400, 'GOOGLE_NOT_CONFIGURED', 'Google is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }
    const { state, codeChallenge } = sealState(this.box, who);
    return { authorizeUrl: this.google.authorizeUrl(state, codeChallenge), state };
  }

  async complete(who: SessionIdentity, code: string, state: string): Promise<GoogleConnectionDTO> {
    const p = openState(this.box, state);
    if (!p) throw fail(400, 'OAUTH_STATE_INVALID', 'This Google authorization is not valid. Start the connection again.');
    if (p.exp < Date.now()) throw fail(400, 'OAUTH_STATE_EXPIRED', 'This Google authorization expired. Start the connection again.');
    if (p.org !== who.organizationId || p.usr !== who.userId || p.sid !== who.sessionId) {
      throw fail(
        403,
        'OAUTH_SESSION_MISMATCH',
        'This Google authorization was started from a different session. Start it again from this window.',
      );
    }
    // Spent before the exchange, so a double submit cannot run two exchanges.
    this.consumeNonce(p.nonce, p.exp);

    let tokens;
    try {
      tokens = await this.google.exchangeCode(code, p.cv);
    } catch (e) {
      if (e instanceof GoogleApiError && e.kind === 'REAUTH') {
        throw fail(400, 'OAUTH_CODE_REJECTED', 'Google rejected the authorization code. Start the connection again.');
      }
      throw this.toHttp(e);
    }

    // From here on Google has issued live tokens. Any refusal hands them back,
    // so a grant we are not going to keep never lingers on the account.
    const liveToken = tokens.refreshToken ?? tokens.accessToken;
    const refuse = async (status: number, errCode: string, message: string) => {
      await this.revokeQuietly(liveToken);
      return fail(status, errCode, message);
    };

    if (!tokens.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
      throw await refuse(
        400,
        'GOOGLE_SCOPE_NOT_GRANTED',
        'Google did not grant access to the files you choose. Connect again and leave that permission ticked.',
      );
    }
    const identity = decodeIdToken(tokens.idToken, this.google.clientId);
    if (!identity) throw await refuse(502, 'GOOGLE_IDENTITY_MISSING', 'Google did not say which account was connected. Try again.');
    if (!tokens.refreshToken) {
      throw await refuse(502, 'GOOGLE_NO_REFRESH_TOKEN', 'Google did not issue a long-lived token. Try connecting again.');
    }
    const refreshToken = tokens.refreshToken;

    let saved;
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        // Serialises completions for one organization: two tabs finishing at
        // once must not both pass the one-account check and insert two rows.
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${who.organizationId}::uuid FOR UPDATE`;

        const live = await tx.provider_credentials.findMany({
          where: { organization_id: who.organizationId, provider: GOOGLE_PROVIDER, revoked_at: null },
          select: { id: true, external_account_id: true, account_email: true },
        });
        const other = live.find((c) => c.external_account_id !== identity.sub);
        if (other) throw new AccountConflict(other.account_email);

        const existing = live.find((c) => c.external_account_id === identity.sub);
        // The id exists before encrypting: the AAD binds the ciphertext to its row.
        const id = existing?.id ?? newId();
        const data = {
          credential_enc: this.box.encrypt(refreshToken, providerCredentialAad(who.organizationId, id)),
          credential_hash: sha256Hex(refreshToken),
          label: identity.email,
          account_email: identity.email,
          external_account_id: identity.sub,
          status: CredentialStatus.ACTIVE,
          last_verified_at: new Date(),
          last_error_at: null,
          last_error_code: null,
          updated_at: new Date(),
        };
        const row = existing
          ? await tx.provider_credentials.update({ where: { id }, data, select: CONNECTION_SELECT })
          : await tx.provider_credentials.create({
              data: {
                id,
                organization_id: who.organizationId,
                provider: GOOGLE_PROVIDER,
                // NOT NULL columns built for API keys. An OAuth token has no
                // display fragment worth showing, and none of it is stored.
                credential_prefix: 'oauth',
                credential_last4: '',
                ...data,
              },
              select: CONNECTION_SELECT,
            });

        // A sheet stays bound to the connection it was added with, and a
        // disconnect retires that row: reconnecting creates a new one. Move this
        // account's sheets onto it, or they could never run again. Sheets of
        // another account stay where they are — this one may not be able to
        // open them; picking such a file again rebinds it (SheetSourcesService.create).
        const retired = await tx.provider_credentials.findMany({
          where: { organization_id: who.organizationId, provider: GOOGLE_PROVIDER, external_account_id: identity.sub, revoked_at: { not: null } },
          select: { id: true },
        });
        const moved = retired.length
          ? await tx.lead_sources.updateMany({
              where: { organization_id: who.organizationId, provider_credential_id: { in: retired.map((r) => r.id) } },
              data: { provider_credential_id: id, updated_at: new Date() },
            })
          : { count: 0 };

        await tx.audit_logs.create({
          data: {
            id: newId(),
            organization_id: who.organizationId,
            actor_type: 'user',
            actor_id: who.userId,
            action: existing ? 'google.reconnected' : 'google.connected',
            entity_type: 'provider_credential',
            entity_id: id,
            payload: { accountEmail: identity.email, sheetsReattached: moved.count } as never,
          },
        });
        return row;
      });
    } catch (e) {
      if (e instanceof AccountConflict) {
        throw await refuse(
          409,
          'GOOGLE_ACCOUNT_CONFLICT',
          `This organization is already connected to ${e.email ?? 'another Google account'}. Disconnect it first to use a different account.`,
        );
      }
      // Nothing was stored, so nothing should stay authorized either.
      await this.revokeQuietly(liveToken);
      throw e;
    }

    this.accessTokens.set(saved.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    this.logger.log(`Google connected for organization ${who.organizationId} (credential ${saved.id})`);
    return toDTO(saved);
  }

  async list(organizationId: string): Promise<GoogleConnectionDTO[]> {
    const rows = await this.prisma.provider_credentials.findMany({
      where: { organization_id: organizationId, provider: GOOGLE_PROVIDER, revoked_at: null },
      select: CONNECTION_SELECT,
      orderBy: { created_at: 'desc' },
    });
    return rows.map(toDTO);
  }

  /**
   * Hand the grant back to Google, then forget it. The revoke is best effort —
   * a credential we can no longer decrypt or that Google already dropped is
   * exactly when the owner most needs disconnect to succeed — but the local
   * ciphertext is cleared either way.
   */
  async disconnect(who: SessionIdentity, id: string): Promise<void> {
    const row = await this.prisma.provider_credentials.findFirst({
      where: { id, organization_id: who.organizationId, provider: GOOGLE_PROVIDER, revoked_at: null },
      select: { id: true, organization_id: true, credential_enc: true },
    });
    if (!row) throw fail(404, 'GOOGLE_CONNECTION_NOT_FOUND', 'No such Google connection.');

    if (row.credential_enc) {
      try {
        await this.google.revoke(this.decrypt(row));
      } catch (e) {
        this.logger.warn(`Google revoke skipped for credential ${row.id}: ${(e as Error).message}`);
      }
    }

    await this.prisma.provider_credentials.update({
      where: { id: row.id },
      data: { status: CredentialStatus.REVOKED, revoked_at: new Date(), credential_enc: '', updated_at: new Date() },
    });
    this.accessTokens.delete(row.id);

    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: who.organizationId,
        actor_type: 'user',
        actor_id: who.userId,
        action: 'google.disconnected',
        entity_type: 'provider_credential',
        entity_id: row.id,
      },
    });
  }

  /**
   * Prove the backend can open a spreadsheet the owner picked: its Drive
   * metadata, its tabs, and a small block of the first tab.
   *
   * Picking a file in the browser does not by itself prove the server can read
   * it — with drive.file the grant belongs to this OAuth client and Google
   * account, and a different account in the browser would grant nothing here.
   */
  async inspectSpreadsheet(
    organizationId: string,
    credentialId: string,
    spreadsheetId: string,
  ): Promise<SpreadsheetInspectionDTO> {
    return this.withAccessToken(organizationId, credentialId, async (token) => {
      const file = await this.google.driveFile(token, spreadsheetId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The spreadsheet is in the trash', 404);
      if (file.mimeType !== SPREADSHEET_MIME) {
        throw fail(400, 'GOOGLE_NOT_A_SPREADSHEET', 'That file is not a Google Sheets spreadsheet.');
      }

      const sheet = await this.google.spreadsheet(token, spreadsheetId);
      const tabs = (sheet.sheets ?? [])
        .map((s) => s.properties)
        // Chart sheets and the like hold no cells to import.
        .filter((t) => !t.sheetType || t.sheetType === 'GRID')
        .sort((a, b) => a.index - b.index)
        .map((t) => ({
          sheetId: t.sheetId,
          title: t.title,
          index: t.index,
          rowCount: t.gridProperties?.rowCount ?? null,
          columnCount: t.gridProperties?.columnCount ?? null,
        }));

      const first = tabs[0];
      const rows = first
        ? await this.google.readGrid(token, spreadsheetId, first.sheetId, SAMPLE_ROWS, SAMPLE_COLUMNS)
        : [];

      return {
        spreadsheetId,
        title: sheet.properties?.title ?? file.name,
        version: file.version ?? null,
        modifiedTime: file.modifiedTime ?? null,
        tabs,
        sample: first ? { sheetId: first.sheetId, title: first.title, rows } : null,
      };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Runs `fn` with a valid access token, refreshing once if Google rejects the
   * cached one. Google failures come out as the API's HttpException envelope
   * (GOOGLE_REAUTH_REQUIRED, GOOGLE_FILE_NOT_FOUND, …), so callers branch on
   * the code and never see a token.
   */
  async withAccessToken<T>(
    organizationId: string,
    credentialId: string,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    // An undefined id would drop the filter and match any Google row in the
    // organization; a source whose credential was revoked (SET NULL) must not.
    if (!credentialId) throw fail(409, 'GOOGLE_REAUTH_REQUIRED', 'Reconnect Google to continue.');
    const row = await this.prisma.provider_credentials.findFirst({
      where: { id: credentialId, organization_id: organizationId, provider: GOOGLE_PROVIDER, revoked_at: null },
      select: { id: true, organization_id: true, credential_enc: true, status: true },
    });
    if (!row) {
      throw fail(
        404,
        'GOOGLE_CONNECTION_NOT_FOUND',
        'The Google connection for this was disconnected. Connect Google again, or pick the spreadsheet again with “Add a spreadsheet”.',
      );
    }
    if (row.status === CredentialStatus.INVALID) throw this.toHttp(new GoogleApiError('REAUTH', 'credential invalid', 400));

    try {
      return await fn(await this.accessToken(row));
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.kind === 'UNAUTHORIZED')) throw this.toHttp(e);
    }
    this.accessTokens.delete(row.id);
    try {
      return await fn(await this.accessToken(row));
    } catch (e) {
      throw this.toHttp(e);
    }
  }

  private async accessToken(row: { id: string; organization_id: string; credential_enc: string }): Promise<string> {
    const cached = this.accessTokens.get(row.id);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

    let tokens;
    try {
      tokens = await this.google.refresh(this.decrypt(row));
    } catch (e) {
      if (e instanceof GoogleApiError && e.kind === 'REAUTH') await this.markInvalid(row.id, 'GOOGLE_REAUTH_REQUIRED');
      throw e;
    }
    // The owner can withdraw file access in their Google settings without
    // revoking the whole grant; a refresh then comes back without the scope.
    if (tokens.scope && !tokens.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
      await this.markInvalid(row.id, 'GOOGLE_SCOPE_NOT_GRANTED');
      throw new GoogleApiError('REAUTH', 'drive.file scope no longer granted', 400);
    }

    this.accessTokens.set(row.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    await this.prisma.provider_credentials.update({ where: { id: row.id }, data: { last_verified_at: new Date() } });
    return tokens.accessToken;
  }

  private async markInvalid(id: string, code: string): Promise<void> {
    this.accessTokens.delete(id);
    await this.prisma.provider_credentials.update({
      where: { id },
      data: { status: CredentialStatus.INVALID, last_error_at: new Date(), last_error_code: code },
    });
  }

  private consumeNonce(nonce: string, exp: number): void {
    const now = Date.now();
    for (const [n, e] of this.usedNonces) if (e < now) this.usedNonces.delete(n);
    if (this.usedNonces.has(nonce)) {
      throw fail(400, 'OAUTH_STATE_USED', 'This Google authorization was already used. Start the connection again.');
    }
    this.usedNonces.set(nonce, exp);
  }

  private async revokeQuietly(token: string): Promise<void> {
    try {
      await this.google.revoke(token);
    } catch (e) {
      this.logger.warn(`Google revoke failed: ${(e as Error).message}`);
    }
  }

  private decrypt(row: { id: string; organization_id: string; credential_enc: string }): string {
    return this.box.decrypt(row.credential_enc, providerCredentialAad(row.organization_id, row.id));
  }

  /**
   * Google failures in the API's error envelope. Never 401: the SPA reads a 401
   * as "your session ended" and signs the owner out.
   */
  private toHttp(e: unknown): unknown {
    if (!(e instanceof GoogleApiError)) return e;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return fail(409, 'GOOGLE_REAUTH_REQUIRED', 'Google access was revoked or has expired. Reconnect Google to continue.');
      case 'DENIED':
        return fail(
          403,
          'GOOGLE_FILE_ACCESS_DENIED',
          'EstatePulse cannot open that spreadsheet with this Google account. Select it again with the Google picker, signed in as the connected account.',
        );
      case 'NOT_FOUND':
        return fail(
          404,
          'GOOGLE_FILE_NOT_FOUND',
          'Spreadsheet not found. It may be deleted or trashed, or it was not selected with the Google picker as the connected account.',
        );
      case 'RATE_LIMITED':
        return fail(429, 'GOOGLE_RATE_LIMITED', 'Google is rate-limiting requests. Try again in a minute.');
      case 'UNAVAILABLE':
        return fail(502, 'GOOGLE_UNAVAILABLE', 'Google did not respond. Try again shortly.');
      default:
        return fail(502, 'GOOGLE_REQUEST_FAILED', `Google refused the request: ${e.message}`);
    }
  }
}

function toDTO(row: {
  id: string;
  account_email: string | null;
  status: string;
  last_verified_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}): GoogleConnectionDTO {
  return {
    id: row.id,
    accountEmail: row.account_email,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
    connectedAt: row.created_at,
  };
}

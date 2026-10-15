import { Injectable, Logger } from '@nestjs/common';
import { IntegrationProvider, IntegrationStatus, type Integration } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { httpError } from '@/common/errors/app-error';
import { lockOrganization } from '@/calendar/connection/calendar-access.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, sha256Hex } from '@/common/utils/crypto';
import { DRIVE_FILE_SCOPE, GoogleApiError, GoogleClient, SPREADSHEET_MIME, decodeIdToken } from './google.client';
import { openState, sealState } from './oauth-state';

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
  status: string;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  connectedAt: Date;
}

export interface SpreadsheetInspectionDTO {
  spreadsheetId: string;
  title: string;
  version: string | null;
  modifiedTime: string | null;
  tabs: { sheetId: number; title: string; index: number; rowCount: number | null; columnCount: number | null }[];
  sample: { sheetId: number; title: string; rows: string[][] } | null;
}

class AccountConflict extends Error {
  constructor(readonly email: string | null) {
    super('account conflict');
  }
}

const LIVE_GOOGLE = (orgId: string) => ({ orgId, provider: IntegrationProvider.google, revokedAt: null });

/**
 * The organization's one Google account, connected with the drive.file scope
 * (only files the owner picks) and PKCE, its refresh token sealed to the row.
 */
@Injectable()
export class GoogleConnectionsService {
  private readonly logger = new Logger(GoogleConnectionsService.name);
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly google: GoogleClient,
    private readonly audit: AuditService,
  ) {}

  publicConfig() {
    const configured = this.google.isConfigured();
    return { configured, clientId: configured ? this.google.clientId : null, ...this.google.pickerConfig(), scope: DRIVE_FILE_SCOPE };
  }

  start(who: SessionIdentity): { authorizeUrl: string; state: string } {
    if (!this.google.isConfigured()) {
      throw httpError(400, 'GOOGLE_NOT_CONFIGURED', 'Google is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }
    const { state, codeChallenge } = sealState(this.secrets, who);
    return { authorizeUrl: this.google.authorizeUrl(state, codeChallenge), state };
  }

  /** The state must come back to the same session that started it, once. */
  async complete(who: SessionIdentity, code: string, state: string): Promise<GoogleConnectionDTO> {
    const p = openState(this.secrets, state);
    if (!p) throw httpError(400, 'OAUTH_STATE_INVALID', 'This Google authorization is not valid. Start the connection again.');
    if (p.exp < Date.now()) throw httpError(400, 'OAUTH_STATE_EXPIRED', 'This Google authorization expired. Start the connection again.');
    if (p.org !== who.organizationId || p.usr !== who.userId || p.sid !== who.sessionId) {
      throw httpError(403, 'OAUTH_SESSION_MISMATCH', 'This Google authorization was started from a different session. Start it again from this window.');
    }
    this.consumeNonce(p.nonce, p.exp);

    let tokens;
    try {
      tokens = await this.google.exchangeCode(code, p.cv);
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'REAUTH') {
        throw httpError(400, 'OAUTH_CODE_REJECTED', 'Google rejected the authorization code. Start the connection again.');
      }
      throw this.toHttp(error);
    }

    const liveToken = tokens.refreshToken ?? tokens.accessToken;
    const refuse = async (status: number, errorCode: string, message: string) => {
      await this.revokeQuietly(liveToken);
      return httpError(status, errorCode, message);
    };
    if (!tokens.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
      throw await refuse(400, 'GOOGLE_SCOPE_NOT_GRANTED', 'Google did not grant access to the files you choose. Connect again and leave that permission ticked.');
    }
    const identity = decodeIdToken(tokens.idToken, this.google.clientId);
    if (!identity) throw await refuse(502, 'GOOGLE_IDENTITY_MISSING', 'Google did not say which account was connected. Try again.');
    if (!tokens.refreshToken) {
      throw await refuse(502, 'GOOGLE_NO_REFRESH_TOKEN', 'Google did not issue a long-lived token. Try connecting again.');
    }
    const refreshToken = tokens.refreshToken;

    let saved: Integration;
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        await lockOrganization(tx, who.organizationId);
        const live = await tx.integration.findMany({
          where: LIVE_GOOGLE(who.organizationId),
          select: { id: true, externalAccountId: true, accountEmail: true },
        });
        const other = live.find((c) => c.externalAccountId !== identity.sub);
        if (other) throw new AccountConflict(other.accountEmail);
        const existing = live.find((c) => c.externalAccountId === identity.sub);
        const id = existing?.id ?? randomUUID();
        const data = {
          credentials: this.secrets.seal(refreshToken, aad.integration(who.organizationId, id)),
          credentialHash: sha256Hex(refreshToken),
          credentialPreview: 'oauth',
          label: identity.email,
          accountEmail: identity.email,
          externalAccountId: identity.sub,
          status: IntegrationStatus.active,
          lastVerifiedAt: new Date(),
          lastErrorAt: null,
          lastErrorCode: null,
        };
        const row = existing
          ? await tx.integration.update({ where: { id }, data })
          : await tx.integration.create({ data: { id, orgId: who.organizationId, provider: IntegrationProvider.google, ...data } });

        // Sheets connected through this account before a disconnect come back with it.
        const retired = await tx.integration.findMany({
          where: { orgId: who.organizationId, provider: IntegrationProvider.google, externalAccountId: identity.sub, revokedAt: { not: null } },
          select: { id: true },
        });
        const moved = retired.length
          ? await tx.leadSource.updateMany({
              where: { orgId: who.organizationId, integrationId: { in: retired.map((r) => r.id) } },
              data: { integrationId: id },
            })
          : { count: 0 };
        await this.audit.record(
          {
            orgId: who.organizationId,
            actorType: 'user',
            actorId: who.userId,
            action: existing ? 'google.reconnected' : 'google.connected',
            entityType: 'integration',
            entityId: id,
            payload: { accountEmail: identity.email, sheetsReattached: moved.count },
          },
          tx,
        );
        return row;
      });
    } catch (error) {
      if (error instanceof AccountConflict) {
        throw await refuse(
          409,
          'GOOGLE_ACCOUNT_CONFLICT',
          `This organization is already connected to ${error.email ?? 'another Google account'}. Disconnect it first to use a different account.`,
        );
      }
      await this.revokeQuietly(liveToken);
      throw error;
    }

    this.accessTokens.set(saved.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    this.logger.log(`Google connected for organization ${who.organizationId}`);
    return toDTO(saved);
  }

  async list(orgId: string): Promise<GoogleConnectionDTO[]> {
    const rows = await this.prisma.integration.findMany({ where: LIVE_GOOGLE(orgId), orderBy: { createdAt: 'desc' } });
    return rows.map(toDTO);
  }

  async disconnect(who: SessionIdentity, id: string): Promise<void> {
    const row = await this.prisma.integration.findFirst({ where: { id, ...LIVE_GOOGLE(who.organizationId) } });
    if (!row) throw httpError(404, 'GOOGLE_CONNECTION_NOT_FOUND', 'No such Google connection.');
    if (row.credentials) {
      try {
        await this.google.revoke(this.decrypt(row));
      } catch (error) {
        this.logger.warn(`Google revoke skipped for ${row.id}: ${(error as Error).message}`);
      }
    }
    await this.prisma.integration.update({
      where: { id: row.id },
      data: { status: IntegrationStatus.revoked, revokedAt: new Date(), credentials: '' },
    });
    this.accessTokens.delete(row.id);
    await this.audit.record({
      orgId: who.organizationId,
      actorType: 'user',
      actorId: who.userId,
      action: 'google.disconnected',
      entityType: 'integration',
      entityId: row.id,
    });
  }

  async inspectSpreadsheet(orgId: string, integrationId: string, spreadsheetId: string): Promise<SpreadsheetInspectionDTO> {
    return this.withAccessToken(orgId, integrationId, async (token) => {
      const file = await this.google.driveFile(token, spreadsheetId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The spreadsheet is in the trash', 404);
      if (file.mimeType !== SPREADSHEET_MIME) {
        throw httpError(400, 'GOOGLE_NOT_A_SPREADSHEET', 'That file is not a Google Sheets spreadsheet.');
      }
      const sheet = await this.google.spreadsheet(token, spreadsheetId);
      const tabs = (sheet.sheets ?? [])
        .map((s) => s.properties)
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
      const rows = first ? await this.google.readGrid(token, spreadsheetId, first.sheetId, SAMPLE_ROWS, SAMPLE_COLUMNS) : [];
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

  /** Runs `fn` with a fresh access token, refreshing once when Google says the cached one is no longer good. */
  async withAccessToken<T>(orgId: string, integrationId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    if (!integrationId) throw httpError(409, 'GOOGLE_REAUTH_REQUIRED', 'Reconnect Google to continue.');
    const row = await this.prisma.integration.findFirst({ where: { id: integrationId, ...LIVE_GOOGLE(orgId) } });
    if (!row) {
      throw httpError(
        404,
        'GOOGLE_CONNECTION_NOT_FOUND',
        'The Google connection for this was disconnected. Connect Google again, or pick the spreadsheet again with “Add a spreadsheet”.',
      );
    }
    if (row.status === IntegrationStatus.invalid) throw this.toHttp(new GoogleApiError('REAUTH', 'credential invalid', 400));
    try {
      return await fn(await this.accessToken(row));
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.kind === 'UNAUTHORIZED')) throw this.toHttp(error);
    }
    this.accessTokens.delete(row.id);
    try {
      return await fn(await this.accessToken(row));
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  private async accessToken(row: Integration): Promise<string> {
    const cached = this.accessTokens.get(row.id);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    let tokens;
    try {
      tokens = await this.google.refresh(this.decrypt(row));
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'REAUTH') await this.markInvalid(row.id, 'GOOGLE_REAUTH_REQUIRED');
      throw error;
    }
    if (tokens.scope && !tokens.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
      await this.markInvalid(row.id, 'GOOGLE_SCOPE_NOT_GRANTED');
      throw new GoogleApiError('REAUTH', 'drive.file scope no longer granted', 400);
    }
    this.accessTokens.set(row.id, { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    await this.prisma.integration.update({ where: { id: row.id }, data: { lastVerifiedAt: new Date() } });
    return tokens.accessToken;
  }

  private async markInvalid(id: string, code: string): Promise<void> {
    this.accessTokens.delete(id);
    await this.prisma.integration.update({
      where: { id },
      data: { status: IntegrationStatus.invalid, lastErrorAt: new Date(), lastErrorCode: code },
    });
  }

  private consumeNonce(nonce: string, exp: number): void {
    const now = Date.now();
    for (const [n, e] of this.usedNonces) if (e < now) this.usedNonces.delete(n);
    if (this.usedNonces.has(nonce)) {
      throw httpError(400, 'OAUTH_STATE_USED', 'This Google authorization was already used. Start the connection again.');
    }
    this.usedNonces.set(nonce, exp);
  }

  private async revokeQuietly(token: string): Promise<void> {
    try {
      await this.google.revoke(token);
    } catch (error) {
      this.logger.warn(`Google revoke failed: ${(error as Error).message}`);
    }
  }

  private decrypt(row: Pick<Integration, 'id' | 'orgId' | 'credentials'>): string {
    return this.secrets.open(row.credentials, aad.integration(row.orgId, row.id));
  }

  toHttp(error: unknown): unknown {
    if (!(error instanceof GoogleApiError)) return error;
    switch (error.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return httpError(409, 'GOOGLE_REAUTH_REQUIRED', 'Google access was revoked or has expired. Reconnect Google to continue.');
      case 'DENIED':
        return httpError(
          403,
          'GOOGLE_FILE_ACCESS_DENIED',
          'EstatePulse cannot open that spreadsheet with this Google account. Select it again with the Google picker, signed in as the connected account.',
        );
      case 'NOT_FOUND':
        return httpError(
          404,
          'GOOGLE_FILE_NOT_FOUND',
          'Spreadsheet not found. It may be deleted or trashed, or it was not selected with the Google picker as the connected account.',
        );
      case 'RATE_LIMITED':
        return httpError(429, 'GOOGLE_RATE_LIMITED', 'Google is rate-limiting requests. Try again in a minute.');
      case 'UNAVAILABLE':
        return httpError(502, 'GOOGLE_UNAVAILABLE', 'Google did not respond. Try again shortly.');
      default:
        return httpError(502, 'GOOGLE_REQUEST_FAILED', `Google refused the request: ${error.message}`);
    }
  }
}

function toDTO(row: Integration): GoogleConnectionDTO {
  return {
    id: row.id,
    accountEmail: row.accountEmail,
    status: row.status.toUpperCase(),
    lastVerifiedAt: row.lastVerifiedAt,
    lastErrorCode: row.lastErrorCode,
    connectedAt: row.createdAt,
  };
}

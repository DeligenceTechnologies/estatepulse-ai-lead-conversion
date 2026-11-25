import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { IntegrationProvider, type Prisma } from '@prisma/client';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectionRefused } from '@/connections/connection-definition';
import { ConnectionsService, REAUTH_REQUIRED, type CredentialErrors } from '@/connections/connections.service';
import { DRIVE_FILE_SCOPE, GoogleApiError, GoogleClient, SPREADSHEET_MIME } from './google.client';

const SAMPLE_ROWS = 5;
const SAMPLE_COLUMNS = 6;

export interface SessionIdentity {
  organizationId: string;
  userId: string;
  sessionId: string;
}

export interface SpreadsheetInspectionDTO {
  spreadsheetId: string;
  title: string;
  version: string | null;
  modifiedTime: string | null;
  tabs: { sheetId: number; title: string; index: number; rowCount: number | null; columnCount: number | null }[];
  sample: { sheetId: number; title: string; rows: string[][] } | null;
}

/** What a sheet or a form says on its card when the Google connection it reads through has lapsed. */
export const REAUTH_ERROR_CODE = 'GOOGLE_REAUTH_REQUIRED';

/**
 * A reconnect, carried through to the sheets and forms read with the
 * connection. Without this they keep saying "Reconnect Google to continue"
 * after the owner has done exactly that: a paused sheet is never read again to
 * find out, and a form that kept failing has backed off for hours.
 *
 * A source that is still scheduled is brought forward to now, so its next read
 * settles what it says. One that was paused stays paused (a sheet is only ever
 * switched on by its owner) and just stops reporting the access it has back.
 */
export async function forgetExpiredAccess(
  tx: Pick<Prisma.TransactionClient, 'leadSource'>,
  orgId: string,
  integrationId: string,
  now = new Date(),
): Promise<void> {
  await tx.leadSource.updateMany({
    where: { orgId, integrationId, syncNextAt: { gt: now }, syncFailures: { gt: 0 } },
    data: { syncNextAt: now },
  });
  await tx.leadSource.updateMany({
    where: { orgId, integrationId, remoteErrorCode: REAUTH_ERROR_CODE },
    data: { remoteErrorCode: null, remoteErrorMessage: null, syncFailures: 0 },
  });
}

/** How Google's client reports a refused credential, for ConnectionsService.withCredential. */
const GOOGLE_ERRORS: CredentialErrors = {
  unauthorized: (e) => e instanceof GoogleApiError && e.kind === 'UNAUTHORIZED',
  reauth: (e) => (e instanceof GoogleApiError && e.kind === 'REAUTH' ? REAUTH_REQUIRED : null),
  reauthError: (message) => new GoogleApiError('REAUTH', message, 400),
  unavailableError: (message, status) => new GoogleApiError('UNAVAILABLE', message, status),
};

/**
 * Google as a connection (one account per organization, drive.file scope:
 * only files the owner picks), and reading with it. Connecting, refreshing
 * and disconnecting are ConnectionsService's; Sheets and Forms both read
 * through the same account.
 */
@Injectable()
export class GoogleConnectionsService implements OnModuleInit {
  private readonly logger = new Logger(GoogleConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleClient,
    private readonly connections: ConnectionsService,
  ) {}

  onModuleInit(): void {
    this.connections.register({
      key: 'google',
      provider: IntegrationProvider.google,
      label: 'Google',
      description: 'Import leads from Google Sheets and Google Forms.',
      category: 'leads',
      auth: 'oauth',
      impact: 'New leads from your Google Sheets and Forms are not being imported.',
      unavailable: () => (this.google.clientId ? null : 'Google is not configured on this server. Set GOOGLE_CLIENT_ID.'),
      identify: async (token, raw) => {
        // The token response Nango kept from the consent screen says what was granted.
        const scope = typeof raw.scope === 'string' ? raw.scope : null;
        if (scope !== null && !scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
          throw new ConnectionRefused(400, 'GOOGLE_SCOPE_NOT_GRANTED', 'Google did not grant access to the files you choose. Connect again and leave that permission ticked.');
        }
        const identity = await this.google.userInfo(token);
        return { accountId: identity.sub, email: identity.email, name: identity.email };
      },
      connected: async ({ tx, orgId, row }) => {
        await forgetExpiredAccess(tx, orgId, row.id);
      },
      recovered: (row) => forgetExpiredAccess(this.prisma, row.orgId, row.id),
      // An access token revokes its refresh token too.
      revoke: (token) => this.google.revoke(token),
    });
  }

  publicConfig() {
    const configured = Boolean(this.google.clientId);
    return { configured, clientId: configured ? this.google.clientId : null, ...this.google.pickerConfig(), scope: DRIVE_FILE_SCOPE };
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

  /** Runs `fn` with a valid access token for the organization's Google connection; Google errors come back as API errors. */
  async withAccessToken<T>(orgId: string, integrationId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    if (!integrationId) throw httpError(409, REAUTH_ERROR_CODE, 'Reconnect Google to continue.');
    try {
      return await this.connections.withCredential(orgId, integrationId, 'google', GOOGLE_ERRORS, (token) => fn(token));
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  toHttp(error: unknown): unknown {
    if (!(error instanceof GoogleApiError)) return error;
    switch (error.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return httpError(409, 'GOOGLE_REAUTH_REQUIRED', 'Google access was revoked or has expired. Reconnect Google to continue.');
      case 'API_DISABLED':
        // Nothing the owner does fixes this, so say so and keep Google's own
        // wording (it names the API and the enable link) in the server log.
        this.logger.error(`Google API disabled for this project: ${error.message}`);
        return httpError(
          503,
          'GOOGLE_API_DISABLED',
          'This Google integration is not switched on for EstatePulse yet. Choosing the file again will not help — ask an administrator to enable the Google API for the EstatePulse project.',
        );
      case 'DENIED':
        return httpError(
          403,
          'GOOGLE_FILE_ACCESS_DENIED',
          'EstatePulse cannot open that file with this Google account. Select it again with the Google picker, signed in as the connected account.',
        );
      case 'NOT_FOUND':
        return httpError(
          404,
          'GOOGLE_FILE_NOT_FOUND',
          'That file was not found. It may be deleted or trashed, or it was not selected with the Google picker as the connected account.',
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

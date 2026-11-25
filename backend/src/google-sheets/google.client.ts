import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** The scopes the "google" integration in Nango must request. */
export const GOOGLE_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE] as const;

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const FORMS = 'https://forms.googleapis.com/v1/forms';

export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const FORM_MIME = 'application/vnd.google-apps.form';

export type GoogleErrorKind =
  | 'REAUTH'
  | 'UNAUTHORIZED'
  | 'DENIED'
  /** A 403 the owner cannot fix: the API is switched off for our Cloud project. */
  | 'API_DISABLED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'BAD_REQUEST';

export class GoogleApiError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

export interface GoogleSheetTab {
  sheetId: number;
  title: string;
  index: number;
  sheetType?: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

export interface GoogleSpreadsheet {
  spreadsheetId: string;
  properties?: { title?: string };
  sheets?: { properties: GoogleSheetTab }[];
}

export interface GoogleIdentity {
  sub: string;
  email: string | null;
}

/**
 * Google's APIs, called with an access token Nango issued. The OAuth flow and
 * token refresh are Nango's (the "google" integration); nothing here sees a
 * client secret or a refresh token.
 */
@Injectable()
export class GoogleClient {
  constructor(private readonly config: ConfigService) {}

  /** Public: the browser's Google Picker uses it. The same OAuth client as Nango's "google" integration. */
  get clientId(): string {
    return this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
  }

  pickerConfig(): { apiKey: string | null; appId: string | null } {
    return {
      apiKey: this.config.get<string>('GOOGLE_PICKER_API_KEY') || null,
      appId: this.config.get<string>('GOOGLE_APP_ID') || null,
    };
  }

  /** Which Google account the token belongs to (OpenID Connect userinfo; needs openid + email). */
  async userInfo(accessToken: string): Promise<GoogleIdentity> {
    const body = await this.getJson<{ sub?: unknown; email?: unknown }>(USERINFO_URL, accessToken);
    if (typeof body.sub !== 'string' || !body.sub) throw new GoogleApiError('BAD_REQUEST', 'Google did not say which account this is', 200);
    return { sub: body.sub, email: typeof body.email === 'string' ? body.email : null };
  }

  /** Revokes the grant at Google. An access token revokes its refresh token too. */
  async revoke(token: string): Promise<void> {
    const res = await this.send(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });

    if (res.ok || res.status === 400) return;
    throw await this.apiError(res);
  }

  async driveFile(accessToken: string, fileId: string): Promise<GoogleDriveFile> {
    const fields = 'id,name,mimeType,version,modifiedTime,trashed';
    return this.getJson(
      `${DRIVE_FILES}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
      accessToken,
    );
  }

  async spreadsheet(accessToken: string, spreadsheetId: string): Promise<GoogleSpreadsheet> {
    const fields =
      'spreadsheetId,properties.title,sheets.properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount))';
    return this.getJson(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
      accessToken,
    );
  }

  /**
   * A form's question schema (Google Forms API `forms.get`).
   *
   * Reachable with the drive.file scope this app already asks for: Google's
   * own discovery document lists drive.file among the accepted scopes for
   * forms.get and forms.responses.list, and drive.file covers exactly the
   * files the owner picked in the Google Picker. No extra scope, no new
   * consent screen, no re-verification. See docs/google-forms.md.
   */
  async form<T>(accessToken: string, formId: string): Promise<T> {
    return this.getJson<T>(`${FORMS}/${encodeURIComponent(formId)}`, accessToken);
  }

  /**
   * A page of a form's responses, newest submissions included.
   *
   * `since` filters server-side on Google's own submission timestamp, which is
   * what makes a recovery poll cheap. Drive's `file.version` is NOT used to
   * decide whether anything arrived: a form's version tracks edits to the
   * form, not the responses to it, so it would miss every new submission.
   */
  async formResponses<T>(
    accessToken: string,
    formId: string,
    opts: { since?: Date | null; pageSize?: number; pageToken?: string | null } = {},
  ): Promise<T> {
    const q = new URLSearchParams();
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize));
    if (opts.pageToken) q.set('pageToken', opts.pageToken);
    if (opts.since) q.set('filter', `timestamp > ${opts.since.toISOString()}`);
    const query = q.toString();
    return this.getJson<T>(`${FORMS}/${encodeURIComponent(formId)}/responses${query ? `?${query}` : ''}`, accessToken);
  }

  async readGrid(
    accessToken: string,
    spreadsheetId: string,
    sheetId: number,
    rows: number,
    columns: number,
    startRow = 0,
  ): Promise<string[][]> {
    const res = await this.send(`${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchGetByDataFilter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataFilters: [
          {
            gridRange: {
              sheetId,
              startRowIndex: startRow,
              endRowIndex: startRow + rows,
              startColumnIndex: 0,
              endColumnIndex: columns,
            },
          },
        ],
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    });
    if (!res.ok) throw await this.apiError(res);
    const body = (await res.json()) as { valueRanges?: { valueRange?: { values?: unknown[][] } }[] };
    const values = body.valueRanges?.[0]?.valueRange?.values ?? [];
    return values.map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
  }

  /**
   * Writes single cells of one tab, addressed like readGrid by sheetId and 0-based row and
   * column, so neither the tab's title nor A1 notation is needed. RAW: what is written is
   * stored as typed text, so a "+1415…" phone is not read as a formula or a number.
   */
  async writeCells(accessToken: string, spreadsheetId: string, sheetId: number, cells: { row: number; col: number; value: string }[]): Promise<void> {
    if (cells.length === 0) return;
    const res = await this.send(`${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchUpdateByDataFilter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: cells.map((c) => ({
          dataFilter: { gridRange: { sheetId, startRowIndex: c.row, endRowIndex: c.row + 1, startColumnIndex: c.col, endColumnIndex: c.col + 1 } },
          majorDimension: 'ROWS',
          values: [[c.value]],
        })),
      }),
    });
    if (!res.ok) throw await this.apiError(res);
  }

  private async getJson<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.send(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw await this.apiError(res);
    return (await res.json()) as T;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const timeout = Number(this.config.get('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000);
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new GoogleApiError('UNAVAILABLE', 'Google did not respond', 0);
    }
  }

  private async apiError(res: Response): Promise<GoogleApiError> {
    const body = (await res.json().catch(() => ({}))) as {
      error?:
        | { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] }
        | string;
    };
    const e = typeof body.error === 'object' ? body.error : undefined;
    const message = (e?.message ?? `Google returned HTTP ${res.status}`).slice(0, 300);
    // Classic Drive/Sheets errors carry `errors[].reason`; the newer APIs
    // (Forms among them) put the same code in `details[].reason` instead.
    const reasons = [...(e?.errors ?? []), ...(e?.details ?? [])].map((x) => x.reason);
    const rateLimited =
      res.status === 429 ||
      e?.status === 'RESOURCE_EXHAUSTED' ||
      reasons.includes('rateLimitExceeded') ||
      reasons.includes('userRateLimitExceeded');

    if (rateLimited) return new GoogleApiError('RATE_LIMITED', message, res.status);
    if (res.status === 401) return new GoogleApiError('UNAUTHORIZED', message, 401);
    // "The API is off for our project" and "this account cannot open that file"
    // are both 403, but only the second one is the owner's to fix. Telling them
    // to pick the file again when the API is disabled is an endless loop.
    if (res.status === 403 && reasons.includes('SERVICE_DISABLED')) return new GoogleApiError('API_DISABLED', message, 403);
    if (res.status === 403) return new GoogleApiError('DENIED', message, 403);
    if (res.status === 404) return new GoogleApiError('NOT_FOUND', message, 404);
    if (res.status >= 500) return new GoogleApiError('UNAVAILABLE', message, res.status);
    return new GoogleApiError('BAD_REQUEST', message, res.status);
  }
}

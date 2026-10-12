import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Everything that talks to Google over HTTP.
 *
 * Bare `fetch`, like calendly.client.ts and telnyx/voice.service.ts: a handful
 * of endpoints does not justify a dependency that would own our token refresh.
 *
 * Tokens travel only in an Authorization header or a POST body — never in a URL —
 * so no proxy, access log or error message along the way can capture one. Error
 * messages carry Google's own `error`/`message` text, which never echoes a token.
 */

/**
 * Per-file access: only spreadsheets the owner explicitly opens with this app
 * through the Google Picker. Non-sensitive, unlike `spreadsheets.readonly`,
 * which would expose every sheet in the account.
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** `openid email` only labels the connection with the account it belongs to. */
const SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE].join(' ');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/**
 * REAUTH: the refresh token is dead (revoked, expired, password reset) — park
 * the connection and ask the owner to reconnect; never retry.
 * UNAUTHORIZED: this access token was rejected — refresh once and retry.
 */
export type GoogleErrorKind =
  | 'REAUTH'
  | 'UNAUTHORIZED'
  | 'DENIED'
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

export interface GoogleTokens {
  accessToken: string;
  expiresIn: number;
  /** Only on a code exchange with prompt=consent; absent on a refresh. */
  refreshToken: string | null;
  scope: string;
  idToken: string | null;
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

@Injectable()
export class GoogleClient {
  constructor(private readonly config: ConfigService) {}

  get clientId(): string {
    return this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
  }

  private get clientSecret(): string {
    return this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
  }

  /**
   * A static page on the APP's origin, not an API route. It hands the code to
   * the tab that started the flow, which completes it on its own session — and
   * because the code arrives at the API in a POST body, it never appears in an
   * API access log. Must match the Google Cloud console entry exactly.
   */
  get redirectUri(): string {
    const override = this.config.get<string>('GOOGLE_REDIRECT_URI');
    if (override) return override;
    const app = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
    return `${app.replace(/\/+$/, '')}/oauth/google-callback.html`;
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Public by design: the browser needs these to show the Google Picker. */
  pickerConfig(): { apiKey: string | null; appId: string | null } {
    return {
      apiKey: this.config.get<string>('GOOGLE_PICKER_API_KEY') || null,
      appId: this.config.get<string>('GOOGLE_APP_ID') || null,
    };
  }

  authorizeUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      // offline + consent: the only combination that reliably returns a refresh
      // token, including on a reconnect of an account that consented before.
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${q.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Revoking a refresh token also kills every access token minted from it. */
  async revoke(token: string): Promise<void> {
    const res = await this.send(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 invalid_token means it is already dead, which is what we wanted.
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
   * A block of one tab — `rows` rows from `startRow` (0-based), the first
   * `columns` columns — addressed by sheetId rather than by title, so a renamed
   * tab still resolves. Values are as displayed (FORMATTED_VALUE). Google omits
   * trailing empty rows, so fewer rows than asked for means the end of the data.
   */
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

  // -------------------------------------------------------------------------

  private async tokenRequest(params: Record<string, string>): Promise<GoogleTokens> {
    const res = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const err = body.error ?? `http_${res.status}`;
      if (err === 'invalid_grant') {
        // On a refresh this is a dead credential; on an exchange the code was
        // expired, reused, or minted for another PKCE challenge. The caller
        // knows which and words it accordingly.
        throw new GoogleApiError('REAUTH', 'Google rejected the grant (invalid_grant)', res.status);
      }
      if (res.status === 429) throw new GoogleApiError('RATE_LIMITED', 'Google rate limit on the token endpoint', 429);
      if (res.status >= 500) throw new GoogleApiError('UNAVAILABLE', 'Google token endpoint unavailable', res.status);
      throw new GoogleApiError('BAD_REQUEST', `Google token endpoint refused the request (${err})`, res.status);
    }
    return {
      accessToken: body.access_token,
      expiresIn: Number(body.expires_in ?? 3600),
      refreshToken: body.refresh_token ?? null,
      scope: body.scope ?? '',
      idToken: body.id_token ?? null,
    };
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
      // The URL is deliberately left out of the message: it is a Google endpoint
      // either way, and keeping URLs out of errors keeps ids out of logs.
      throw new GoogleApiError('UNAVAILABLE', 'Google did not respond', 0);
    }
  }

  private async apiError(res: Response): Promise<GoogleApiError> {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string; errors?: { reason?: string }[] } | string;
    };
    const e = typeof body.error === 'object' ? body.error : undefined;
    const message = (e?.message ?? `Google returned HTTP ${res.status}`).slice(0, 300);
    const reasons = (e?.errors ?? []).map((x) => x.reason);
    const rateLimited =
      res.status === 429 ||
      e?.status === 'RESOURCE_EXHAUSTED' ||
      reasons.includes('rateLimitExceeded') ||
      reasons.includes('userRateLimitExceeded');

    if (rateLimited) return new GoogleApiError('RATE_LIMITED', message, res.status);
    if (res.status === 401) return new GoogleApiError('UNAUTHORIZED', message, 401);
    if (res.status === 403) return new GoogleApiError('DENIED', message, 403);
    if (res.status === 404) return new GoogleApiError('NOT_FOUND', message, 404);
    if (res.status >= 500) return new GoogleApiError('UNAVAILABLE', message, res.status);
    return new GoogleApiError('BAD_REQUEST', message, res.status);
  }
}

/**
 * Who the tokens belong to, read from the ID token in the same response.
 *
 * The signature is not verified, and does not need to be: the token came
 * straight from Google's token endpoint over TLS in response to our own
 * client-authenticated request (OpenID Connect Core §3.1.3.7). The claims that
 * guard against a token meant for someone else — audience, issuer, expiry —
 * are still checked.
 */
export function decodeIdToken(idToken: string | null, clientId: string, now = Date.now()): GoogleIdentity | null {
  if (!idToken) return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  let claims: { sub?: unknown; email?: unknown; aud?: unknown; iss?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (claims.aud !== clientId) return null;
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 5 * 60 * 1000) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
}

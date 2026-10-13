import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_FILE_SCOPE, GoogleApiError, GoogleClient, decodeIdToken } from './google.client';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const SECRET = 'client-secret-DO-NOT-LEAK';

const client = (extra: Record<string, string> = {}) =>
  new GoogleClient(
    new ConfigService({
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: SECRET,
      PUBLIC_APP_URL: 'http://localhost:3000',
      ...extra,
    }),
  );

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const idToken = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('authorizeUrl', () => {
  it('asks for drive.file with PKCE, offline access and forced consent — and never carries the secret', () => {
    const url = new URL(client().authorizeUrl('STATE', 'CHALLENGE'));
    const q = url.searchParams;

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(q.get('scope')!.split(' ')).toEqual(['openid', 'email', DRIVE_FILE_SCOPE]);
    expect(q.get('code_challenge')).toBe('CHALLENGE');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toContain('consent');
    expect(q.get('state')).toBe('STATE');
    expect(q.get('redirect_uri')).toBe('http://localhost:3000/oauth/google-callback.html');
    expect(url.toString()).not.toContain(SECRET);
  });

  it('uses GOOGLE_REDIRECT_URI verbatim when set', () => {
    const c = client({ GOOGLE_REDIRECT_URI: 'https://app.example.com/oauth/google-callback.html' });
    expect(new URL(c.authorizeUrl('s', 'c')).searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/oauth/google-callback.html',
    );
  });
});

describe('token endpoint', () => {
  it('sends the code, verifier and secret in the POST body, not the URL', async () => {
    fetchMock.mockResolvedValue(
      json({ access_token: 'AT', expires_in: 3599, refresh_token: 'RT', scope: DRIVE_FILE_SCOPE, id_token: 'x.y.z' }),
    );
    const t = await client().exchangeCode('CODE-1', 'VERIFIER-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('code')).toBe('CODE-1');
    expect(body.get('code_verifier')).toBe('VERIFIER-1');
    expect(body.get('client_secret')).toBe(SECRET);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(t).toEqual({ accessToken: 'AT', expiresIn: 3599, refreshToken: 'RT', scope: DRIVE_FILE_SCOPE, idToken: 'x.y.z' });
  });

  it('maps invalid_grant to REAUTH without echoing anything sensitive', async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const err = await client().refresh('RT-SECRET').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.kind).toBe('REAUTH');
    expect(err.message).not.toContain('RT-SECRET');
  });

  it('treats a network failure as UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(client().refresh('RT')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('revoke posts the token in the body and accepts "already revoked"', async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_token' }, 400));
    await client().revoke('RT-SECRET');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(init.body).get('token')).toBe('RT-SECRET');
  });
});

describe('API error mapping', () => {
  const driveError = async (status: number, body: unknown): Promise<GoogleApiError> => {
    fetchMock.mockResolvedValue(json(body, status));
    try {
      await client().driveFile('AT-SECRET', 'file123456789012345678901');
    } catch (e) {
      return e as GoogleApiError;
    }
    throw new Error('expected the call to reject');
  };

  it('puts the access token in the Authorization header only', async () => {
    fetchMock.mockResolvedValue(json({ id: 'f', name: 'n', mimeType: 'm' }));
    await client().driveFile('AT-SECRET', 'file123456789012345678901');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('AT-SECRET');
    expect(init.headers.Authorization).toBe('Bearer AT-SECRET');
  });

  it.each([
    [401, { error: { message: 'Invalid Credentials' } }, 'UNAUTHORIZED'],
    [403, { error: { message: 'The caller does not have permission' } }, 'DENIED'],
    [403, { error: { message: 'Rate', errors: [{ reason: 'userRateLimitExceeded' }] } }, 'RATE_LIMITED'],
    [429, { error: { message: 'Quota', status: 'RESOURCE_EXHAUSTED' } }, 'RATE_LIMITED'],
    [404, { error: { message: 'File not found' } }, 'NOT_FOUND'],
    [503, {}, 'UNAVAILABLE'],
  ])('HTTP %i -> %s', async (status, body, kind) => {
    expect((await driveError(status, body)).kind).toBe(kind);
  });

  it('reads a tab by sheetId through batchGetByDataFilter and stringifies cells', async () => {
    fetchMock.mockResolvedValue(json({ valueRanges: [{ valueRange: { values: [['Name', 2], [null, 'x']] } }] }));
    const rows = await client().readGrid('AT', 'sheet12345678901234567890', 42, 5, 6);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).dataFilters[0].gridRange).toEqual({
      sheetId: 42,
      startRowIndex: 0,
      endRowIndex: 5,
      startColumnIndex: 0,
      endColumnIndex: 6,
    });
    expect(rows).toEqual([['Name', '2'], ['', 'x']]);
  });
});

describe('decodeIdToken', () => {
  const now = Date.now();
  const good = { sub: 's1', email: 'a@b.test', aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: now / 1000 + 600 };

  it('returns the account for a token issued to this client', () => {
    expect(decodeIdToken(idToken(good), CLIENT_ID, now)).toEqual({ sub: 's1', email: 'a@b.test' });
  });

  it.each([
    ['another audience', { ...good, aud: 'someone-else' }],
    ['another issuer', { ...good, iss: 'https://evil.example' }],
    ['expired', { ...good, exp: now / 1000 - 3600 }],
    ['no subject', { ...good, sub: '' }],
  ])('rejects %s', (_label, claims) => {
    expect(decodeIdToken(idToken(claims), CLIENT_ID, now)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(decodeIdToken(null, CLIENT_ID)).toBeNull();
    expect(decodeIdToken('nonsense', CLIENT_ID)).toBeNull();
  });
});

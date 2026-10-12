import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { SecretBox, providerCredentialAad } from '../../common/crypto';
import { GoogleConnectionsService } from './google-connections.service';
import { DRIVE_FILE_SCOPE, GoogleApiError, SPREADSHEET_MIME } from './google.client';
import { STATE_TTL_MS, sealState } from './oauth-state';

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
const box = new SecretBox(KEYS, 'k1');

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const CRED = '44444444-4444-4444-8444-444444444444';
const WHO = { organizationId: ORG, userId: USER, sessionId: SESSION };
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const REFRESH = '1//refresh-token-SECRET';
const ACCESS = 'ya29.access-token-SECRET';
const SHEET = 'sheet1234567890123456789012345';

const idToken = (sub = 'google-sub-1', email = 'owner@example.test') =>
  `h.${Buffer.from(
    JSON.stringify({ sub, email, aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: Date.now() / 1000 + 3600 }),
  ).toString('base64url')}.sig`;

const rowOf = (data: any) => ({
  id: data.id,
  account_email: data.account_email ?? null,
  status: data.status ?? 'ACTIVE',
  last_verified_at: data.last_verified_at ?? null,
  last_error_code: data.last_error_code ?? null,
  created_at: new Date('2026-10-11T00:00:00Z'),
});

function setup(opts: { live?: any[]; retired?: any[]; row?: any; configured?: boolean } = {}) {
  const google: any = {
    clientId: CLIENT_ID,
    isConfigured: vi.fn(() => opts.configured ?? true),
    pickerConfig: () => ({ apiKey: 'picker-key', appId: '123456' }),
    authorizeUrl: vi.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: ACCESS,
      expiresIn: 3600,
      refreshToken: REFRESH,
      scope: `openid email ${DRIVE_FILE_SCOPE}`,
      idToken: idToken(),
    }),
    refresh: vi.fn().mockResolvedValue({ accessToken: ACCESS, expiresIn: 3600, refreshToken: null, scope: DRIVE_FILE_SCOPE, idToken: null }),
    revoke: vi.fn().mockResolvedValue(undefined),
    driveFile: vi.fn(),
    spreadsheet: vi.fn(),
    readGrid: vi.fn().mockResolvedValue([['Name', 'Phone']]),
  };
  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    provider_credentials: {
      // The live rows; then the account's disconnected rows, none unless given.
      findMany: vi.fn().mockResolvedValueOnce(opts.live ?? []).mockResolvedValue(opts.retired ?? []),
      create: vi.fn(async ({ data }: any) => rowOf(data)),
      update: vi.fn(async ({ where, data }: any) => rowOf({ id: where.id, ...data })),
    },
    lead_sources: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    audit_logs: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    $transaction: vi.fn(async (fn: (t: any) => unknown) => fn(tx)),
    provider_credentials: {
      findFirst: vi.fn().mockResolvedValue(opts.row ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    audit_logs: { create: vi.fn().mockResolvedValue({}) },
  };
  const config = new ConfigService({ ENCRYPTION_KEYS: KEYS, ENCRYPTION_ACTIVE_KEY_ID: 'k1' });
  return { svc: new GoogleConnectionsService(prisma, config, google), prisma, tx, google };
}

const storedRow = (status = 'ACTIVE') => ({
  id: CRED,
  organization_id: ORG,
  credential_enc: box.encrypt(REFRESH, providerCredentialAad(ORG, CRED)),
  status,
});

/** The API error envelope a rejected call produced. */
async function errorOf(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const body = (e as HttpException).getResponse() as { error: { code: string; message: string } };
    return { status: (e as HttpException).getStatus(), ...body.error };
  }
  throw new Error('expected the call to reject');
}

describe('start', () => {
  it('refuses when the server has no Google client configured', () => {
    const { svc } = setup({ configured: false });
    expect(() => svc.start(WHO)).toThrow(HttpException);
  });

  it('returns an authorize URL whose state only this server can open', () => {
    const { svc, google } = setup();
    const { authorizeUrl, state } = svc.start(WHO);
    expect(authorizeUrl).toContain(state);
    expect(google.authorizeUrl).toHaveBeenCalledWith(state, expect.any(String));
    expect(state).not.toContain(ORG);
  });
});

describe('complete', () => {
  it('stores the refresh token encrypted and bound to its row, and returns no secret', async () => {
    const { svc, tx } = setup();
    const { state } = svc.start(WHO);
    const dto = await svc.complete(WHO, 'auth-code-123', state);

    const data = tx.provider_credentials.create.mock.calls[0][0].data;
    expect(data.provider).toBe('GOOGLE');
    expect(data.organization_id).toBe(ORG);
    expect(data.credential_enc).not.toContain(REFRESH);
    expect(box.decrypt(data.credential_enc, providerCredentialAad(ORG, data.id))).toBe(REFRESH);
    // Lifted into another row, the ciphertext no longer decrypts.
    expect(() => box.decrypt(data.credential_enc, providerCredentialAad(ORG, CRED))).toThrow();

    expect(tx.$queryRaw).toHaveBeenCalled(); // organization row locked first
    expect(tx.audit_logs.create.mock.calls[0][0].data).toMatchObject({ action: 'google.connected', actor_id: USER });
    expect(dto).toMatchObject({ accountEmail: 'owner@example.test', status: 'ACTIVE' });
    const text = JSON.stringify(dto);
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(ACCESS);
  });

  it.each([
    ['another organization', { ...WHO, organizationId: '99999999-9999-4999-8999-999999999999' }],
    ['another user', { ...WHO, userId: '99999999-9999-4999-8999-999999999999' }],
    ['another session of the same user', { ...WHO, sessionId: '99999999-9999-4999-8999-999999999999' }],
  ])('refuses completion from %s, before talking to Google', async (_label, caller) => {
    const { svc, google } = setup();
    const { state } = svc.start(WHO);
    const err = await errorOf(svc.complete(caller, 'auth-code-123', state));
    expect(err).toMatchObject({ status: 403, code: 'OAUTH_SESSION_MISMATCH' });
    expect(google.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a forged or expired state', async () => {
    const { svc, google } = setup();
    expect(await errorOf(svc.complete(WHO, 'auth-code-123', 'v1.k1.forged.state.value'))).toMatchObject({
      code: 'OAUTH_STATE_INVALID',
    });
    const old = sealState(box, WHO, Date.now() - STATE_TTL_MS - 1000).state;
    expect(await errorOf(svc.complete(WHO, 'auth-code-123', old))).toMatchObject({ code: 'OAUTH_STATE_EXPIRED' });
    expect(google.exchangeCode).not.toHaveBeenCalled();
  });

  it('accepts a state once: a replay is refused without a second exchange', async () => {
    const { svc, google } = setup();
    const { state } = svc.start(WHO);
    await svc.complete(WHO, 'auth-code-123', state);
    expect(await errorOf(svc.complete(WHO, 'auth-code-456', state))).toMatchObject({ code: 'OAUTH_STATE_USED' });
    expect(google.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('hands the grant back when drive.file was not granted, and stores nothing', async () => {
    const { svc, google, prisma } = setup();
    google.exchangeCode.mockResolvedValue({
      accessToken: ACCESS,
      expiresIn: 3600,
      refreshToken: REFRESH,
      scope: 'openid email',
      idToken: idToken(),
    });
    const { state } = svc.start(WHO);
    expect(await errorOf(svc.complete(WHO, 'auth-code-123', state))).toMatchObject({ code: 'GOOGLE_SCOPE_NOT_GRANTED' });
    expect(google.revoke).toHaveBeenCalledWith(REFRESH);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a second Google account and revokes the one just issued', async () => {
    const { svc, google, tx } = setup({
      live: [{ id: CRED, external_account_id: 'google-sub-OTHER', account_email: 'first@example.test' }],
    });
    const { state } = svc.start(WHO);
    const err = await errorOf(svc.complete(WHO, 'auth-code-123', state));
    expect(err).toMatchObject({ status: 409, code: 'GOOGLE_ACCOUNT_CONFLICT' });
    expect(err.message).toContain('first@example.test');
    expect(google.revoke).toHaveBeenCalledWith(REFRESH);
    expect(tx.provider_credentials.create).not.toHaveBeenCalled();
    expect(tx.provider_credentials.update).not.toHaveBeenCalled();
  });

  it('reconnecting the same account refreshes its row in place', async () => {
    const { svc, tx } = setup({ live: [{ id: CRED, external_account_id: 'google-sub-1', account_email: 'owner@example.test' }] });
    const { state } = svc.start(WHO);
    await svc.complete(WHO, 'auth-code-123', state);

    expect(tx.provider_credentials.create).not.toHaveBeenCalled();
    const { where, data } = tx.provider_credentials.update.mock.calls[0][0];
    expect(where).toEqual({ id: CRED });
    expect(data).toMatchObject({ status: 'ACTIVE', last_error_code: null });
    expect(box.decrypt(data.credential_enc, providerCredentialAad(ORG, CRED))).toBe(REFRESH);
    expect(tx.audit_logs.create.mock.calls[0][0].data.action).toBe('google.reconnected');
  });

  it('reports a rejected authorization code without detail', async () => {
    const { svc, google } = setup();
    google.exchangeCode.mockRejectedValue(new GoogleApiError('REAUTH', 'invalid_grant', 400));
    const { state } = svc.start(WHO);
    expect(await errorOf(svc.complete(WHO, 'auth-code-123', state))).toMatchObject({ status: 400, code: 'OAUTH_CODE_REJECTED' });
  });
});

describe('disconnect', () => {
  it('revokes at Google with the decrypted token, then clears the ciphertext', async () => {
    const { svc, google, prisma } = setup({ row: storedRow() });
    await svc.disconnect(WHO, CRED);

    expect(google.revoke).toHaveBeenCalledWith(REFRESH);
    const { where, data } = prisma.provider_credentials.update.mock.calls[0][0];
    expect(where).toEqual({ id: CRED });
    expect(data).toMatchObject({ status: 'REVOKED', credential_enc: '' });
    expect(prisma.audit_logs.create.mock.calls[0][0].data.action).toBe('google.disconnected');
  });

  it('still disconnects when Google is unreachable', async () => {
    const { svc, google, prisma } = setup({ row: storedRow() });
    google.revoke.mockRejectedValue(new GoogleApiError('UNAVAILABLE', 'Google did not respond', 0));
    await svc.disconnect(WHO, CRED);
    expect(prisma.provider_credentials.update.mock.calls[0][0].data.status).toBe('REVOKED');
  });

  it('only finds connections in the caller organization', async () => {
    const { svc, prisma } = setup({ row: null });
    expect(await errorOf(svc.disconnect(WHO, CRED))).toMatchObject({ status: 404 });
    expect(prisma.provider_credentials.findFirst.mock.calls[0][0].where).toMatchObject({
      id: CRED,
      organization_id: ORG,
      provider: 'GOOGLE',
    });
  });
});

describe('inspectSpreadsheet', () => {
  const sheetMeta = {
    spreadsheetId: SHEET,
    properties: { title: 'Leads 2026' },
    sheets: [
      { properties: { sheetId: 5, title: 'Archive', index: 1 } },
      { properties: { sheetId: 0, title: 'Leads', index: 0, gridProperties: { rowCount: 120, columnCount: 8 } } },
      { properties: { sheetId: 9, title: 'Chart', index: 2, sheetType: 'OBJECT' } },
    ],
  };

  it('reads metadata, grid tabs in order, and a small block of the first tab', async () => {
    const { svc, google } = setup({ row: storedRow() });
    google.driveFile.mockResolvedValue({ id: SHEET, name: 'Leads 2026', mimeType: SPREADSHEET_MIME, version: '17', modifiedTime: 't' });
    google.spreadsheet.mockResolvedValue(sheetMeta);

    const r = await svc.inspectSpreadsheet(ORG, CRED, SHEET);

    expect(r.tabs.map((t) => t.title)).toEqual(['Leads', 'Archive']);
    expect(r.version).toBe('17');
    expect(google.readGrid).toHaveBeenCalledWith(ACCESS, SHEET, 0, 5, 6);
    expect(r.sample).toEqual({ sheetId: 0, title: 'Leads', rows: [['Name', 'Phone']] });
    expect(google.refresh).toHaveBeenCalledWith(REFRESH);
  });

  it('marks the connection for reconnect when Google rejects the refresh token', async () => {
    const { svc, google, prisma } = setup({ row: storedRow() });
    google.refresh.mockRejectedValue(new GoogleApiError('REAUTH', 'invalid_grant', 400));

    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ status: 409, code: 'GOOGLE_REAUTH_REQUIRED' });
    expect(prisma.provider_credentials.update.mock.calls[0][0].data).toMatchObject({
      status: 'INVALID',
      last_error_code: 'GOOGLE_REAUTH_REQUIRED',
    });
  });

  it('marks it too when the owner withdrew file access but kept the grant', async () => {
    const { svc, google, prisma } = setup({ row: storedRow() });
    google.refresh.mockResolvedValue({ accessToken: ACCESS, expiresIn: 3600, refreshToken: null, scope: 'openid email', idToken: null });
    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' });
    expect(prisma.provider_credentials.update.mock.calls[0][0].data.last_error_code).toBe('GOOGLE_SCOPE_NOT_GRANTED');
  });

  it('refuses to call Google at all for a connection already marked invalid', async () => {
    const { svc, google } = setup({ row: storedRow('INVALID') });
    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' });
    expect(google.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once and retries when the access token is rejected', async () => {
    const { svc, google } = setup({ row: storedRow() });
    google.driveFile
      .mockRejectedValueOnce(new GoogleApiError('UNAUTHORIZED', 'Invalid Credentials', 401))
      .mockResolvedValue({ id: SHEET, name: 'x', mimeType: SPREADSHEET_MIME });
    google.spreadsheet.mockResolvedValue(sheetMeta);

    await svc.inspectSpreadsheet(ORG, CRED, SHEET);
    expect(google.refresh).toHaveBeenCalledTimes(2);
  });

  it('explains a file the backend cannot see, a trashed file, and a non-spreadsheet', async () => {
    const { svc, google } = setup({ row: storedRow() });

    google.driveFile.mockRejectedValueOnce(new GoogleApiError('NOT_FOUND', 'File not found', 404));
    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ status: 404, code: 'GOOGLE_FILE_NOT_FOUND' });

    google.driveFile.mockResolvedValueOnce({ id: SHEET, name: 'x', mimeType: SPREADSHEET_MIME, trashed: true });
    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ status: 404, code: 'GOOGLE_FILE_NOT_FOUND' });

    google.driveFile.mockResolvedValueOnce({ id: SHEET, name: 'x.pdf', mimeType: 'application/pdf' });
    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ status: 400, code: 'GOOGLE_NOT_A_SPREADSHEET' });

    google.driveFile.mockRejectedValueOnce(new GoogleApiError('DENIED', 'no permission', 403));
    expect(await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).toMatchObject({ status: 403, code: 'GOOGLE_FILE_ACCESS_DENIED' });
  });

  it('never answers 401, which the browser would read as a signed-out session', async () => {
    const { svc, google } = setup({ row: storedRow() });
    google.driveFile.mockRejectedValue(new GoogleApiError('UNAUTHORIZED', 'Invalid Credentials', 401));
    expect((await errorOf(svc.inspectSpreadsheet(ORG, CRED, SHEET))).status).not.toBe(401);
  });
});

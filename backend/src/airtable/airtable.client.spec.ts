import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirtableClient } from './airtable.client';
import { AirtableApiError, REQUIRED_SCOPES, SCOPES, permissionsOf } from './types';

/**
 * The OAuth and HTTP contract, pinned against Airtable's documented behaviour
 * (verified 2026-11-13). Nothing here reaches the network: every test stubs
 * fetch, so these run anywhere, with or without Airtable credentials.
 */

const config = (over: Record<string, unknown> = {}) =>
  // Pacing off by default here: these tests stub fetch, so spacing requests out
  // would buy nothing but a slower suite.
  ({ get: (k: string) => ({ AIRTABLE_MIN_REQUEST_GAP_MS: 0, ...over })[k] }) as never;

describe('AirtableClient OAuth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends PKCE with S256, which Airtable requires, and asks only for the configured scopes', () => {
    const client = new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli', AIRTABLE_CLIENT_SECRET: 'sec', APP_URL: 'https://app.test' }));

    const url = new URL(client.authorizeUrl('s'.repeat(32), 'challenge-value'));

    expect(url.origin + url.pathname).toBe('https://airtable.com/oauth2/v1/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/oauth/airtable-callback.html');
    // Space delimited, as the authorize endpoint demands.
    expect(url.searchParams.get('scope')).toContain(`${SCOPES.SCHEMA_READ} ${SCOPES.RECORDS_READ}`);
  });

  it('never puts the authorization code or the client secret in a URL', async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, refresh_expires_in: 5_184_000, scope: 'data.records:read schema.bases:read' }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli', AIRTABLE_CLIENT_SECRET: 'sec' }));

    const tokens = await client.exchangeCode('the-code', 'the-verifier');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://airtable.com/oauth2/v1/token');
    expect(url).not.toContain('the-code');
    expect(url).not.toContain('sec');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    // Basic credentials: standard base64 of "id:secret", as RFC 7617 requires.
    // Pinned explicitly, padding included — base64url would silently drop the
    // '=' and Airtable would answer invalid_client.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cli:sec').toString('base64')}`);
    expect(headers.Authorization).toBe('Basic Y2xpOnNlYw==');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, refreshExpiresIn: 5_184_000 });
    expect(tokens.scopes).toEqual(['data.records:read', 'schema.bases:read']);
  });

  it('treats a refused refresh as a dead grant, and a 409 as a race another instance won', async () => {
    const client = new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli', AIRTABLE_CLIENT_SECRET: 'sec', AIRTABLE_RETRY_BASE_MS: 0 }));

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 })));
    await expect(client.refresh('rt')).rejects.toMatchObject({ kind: 'REAUTH' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })));
    await expect(client.refresh('rt')).rejects.toMatchObject({ kind: 'CONFLICT' });
  });

  it('reads the granted scopes from whoami, which is what gates column creation', async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: 'usr123', email: 'a@b.test', scopes: ['data.records:read', 'schema.bases:read'] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli', AIRTABLE_CLIENT_SECRET: 'sec' }));

    const account = await client.identify('tok');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.airtable.com/v0/meta/whoami');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(account).toEqual({ userId: 'usr123', email: 'a@b.test', scopes: ['data.records:read', 'schema.bases:read'] });
  });

  it('hands a 429 back to the caller to back off on rather than holding a request open', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { type: 'TOO_MANY_REQUESTS' } }), { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli', AIRTABLE_CLIENT_SECRET: 'sec', AIRTABLE_RETRY_BASE_MS: 0 }));

    const err = await client.identify('tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AirtableApiError);
    // Airtable's documented recovery is a 30-second wait, too long to sleep in-request.
    expect(err).toMatchObject({ kind: 'RATE_LIMITED', retryAfterMs: 30_000 });
  });

  it('is not configured without both halves of the client credentials', () => {
    expect(new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli' })).isConfigured()).toBe(false);
    expect(new AirtableClient(config({ AIRTABLE_CLIENT_SECRET: 'sec' })).isConfigured()).toBe(false);
    expect(new AirtableClient(config({ AIRTABLE_CLIENT_ID: 'cli', AIRTABLE_CLIENT_SECRET: 'sec' })).isConfigured()).toBe(true);
  });

  it('refuses a deployment whose scopes cannot read Airtable at all', () => {
    const narrowed = new AirtableClient(config({ AIRTABLE_SCOPES: 'data.records:read' }));
    expect(narrowed.missingRequiredRequests()).toEqual([SCOPES.SCHEMA_READ]);
    expect(new AirtableClient(config({})).missingRequiredRequests()).toEqual([]);
  });
});

describe('Airtable permissions', () => {
  it('keeps record write and schema write apart — they are different grants', () => {
    const recordsOnly = permissionsOf([SCOPES.RECORDS_READ, SCOPES.RECORDS_WRITE, SCOPES.SCHEMA_READ]);

    expect(recordsOnly.writeRecords).toBe(true);
    // The whole point of phase 4's gate: creating records never implies creating columns.
    expect(recordsOnly.writeSchema).toBe(false);
    expect(permissionsOf([SCOPES.SCHEMA_WRITE]).writeSchema).toBe(true);
  });

  it('requires only what Airtable cannot be read without', () => {
    expect([...REQUIRED_SCOPES]).toEqual([SCOPES.SCHEMA_READ, SCOPES.RECORDS_READ]);
    expect(REQUIRED_SCOPES).not.toContain(SCOPES.RECORDS_WRITE);
    expect(REQUIRED_SCOPES).not.toContain(SCOPES.SCHEMA_WRITE);
  });
});

describe('repeating a request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never repeats a create, because Airtable has no idempotency key', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config({ AIRTABLE_RETRY_BASE_MS: 0 }));

    await expect(client.createRecords('tok', 'appX', 'tblY', [{ fields: { fldA: 'x' } }])).rejects.toBeInstanceOf(AirtableApiError);

    // The first attempt may well have landed. Sending it again is how a
    // duplicate record appears in somebody's base, so it is sent once and the
    // caller is told it is unsure.
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does repeat a read, which cannot create anything', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ records: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config({ AIRTABLE_RETRY_BASE_MS: 0 }));

    await expect(client.listRecords('tok', 'appX', 'tblY')).resolves.toMatchObject({ records: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('writing records', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ records: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('asks Airtable to typecast, without which a select field cannot be written at all', async () => {
    const fetch = stub();
    const client = new AirtableClient(config({ AIRTABLE_RETRY_BASE_MS: 0 }));

    await client.createRecords('tok', 'appX', 'tblY', [{ fields: { fldA: 'Buyer' } }]);

    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    // A single or multiple select rejects any value that is not already one of
    // its options; typecast is what makes Airtable add it instead of failing
    // the whole batch of ten.
    expect(body.typecast).toBe(true);
    expect(body.returnFieldsByFieldId).toBe(true);
  });

  it('typecasts updates too, and sends them as PATCH so untouched cells survive', async () => {
    const fetch = stub();
    const client = new AirtableClient(config({ AIRTABLE_RETRY_BASE_MS: 0 }));

    await client.updateRecords('tok', 'appX', 'tblY', [{ id: 'recA', fields: { fldA: 'Buyer' } }]);

    const init = fetch.mock.calls[0][1];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string).typecast).toBe(true);
  });
});

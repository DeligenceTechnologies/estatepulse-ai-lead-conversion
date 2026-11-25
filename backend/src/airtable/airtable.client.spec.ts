import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirtableClient } from './airtable.client';
import { AirtableApiError, REQUIRED_SCOPES, SCOPES, permissionsOf } from './types';

/**
 * The HTTP contract, pinned against Airtable's documented behaviour
 * (verified 2026-11-13). Nothing here reaches the network: every test stubs
 * fetch, so these run anywhere, with or without Airtable credentials.
 */

const config = (over: Record<string, unknown> = {}) =>
  // Pacing off by default here: these tests stub fetch, so spacing requests out
  // would buy nothing but a slower suite.
  ({ get: (k: string) => ({ AIRTABLE_MIN_REQUEST_GAP_MS: 0, ...over })[k] }) as never;

describe('AirtableClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the granted scopes from whoami, which is what gates column creation', async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: 'usr123', email: 'a@b.test', scopes: ['data.records:read', 'schema.bases:read'] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config());

    const account = await client.identify('tok');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.airtable.com/v0/meta/whoami');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(account).toEqual({ userId: 'usr123', email: 'a@b.test', scopes: ['data.records:read', 'schema.bases:read'] });
  });

  it('hands a 429 back to the caller to back off on rather than holding a request open', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { type: 'TOO_MANY_REQUESTS' } }), { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const client = new AirtableClient(config({ AIRTABLE_RETRY_BASE_MS: 0 }));

    const err = await client.identify('tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AirtableApiError);
    // Airtable's documented recovery is a 30-second wait, too long to sleep in-request.
    expect(err).toMatchObject({ kind: 'RATE_LIMITED', retryAfterMs: 30_000 });
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

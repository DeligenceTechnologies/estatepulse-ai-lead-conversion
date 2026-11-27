import { describe, expect, it } from 'vitest';
import { ProviderApiError } from '../types';
import { JotformClient } from './jotform.client';
import { JotformProviderAdapter } from './jotform.provider';

const US = 'https://api.jotform.test';
const EU = 'https://eu-api.jotform.test';
const KEY = '0123456789abcdef0123456789abcdef';
const cred = { apiKey: KEY };

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Jotform: `routes` answers by "METHOD url"; every call is recorded. */
function fake(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call = { method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    calls.push(call);
    return routes(call);
  }) as unknown as typeof fetch;
  return { calls, adapter: new JotformProviderAdapter(new JotformClient([US, EU], 1000, fetchFn)) };
}

describe('Jotform credentials', () => {
  it('sends the key in the APIKEY header and unwraps the envelope', async () => {
    const { calls, adapter } = fake(() => json(200, { responseCode: 200, content: { username: 'asha', name: 'Asha V', email: 'a@x.test' } }));
    await expect(adapter.verifyCredential(cred)).resolves.toEqual({ externalAccountId: 'asha', email: 'a@x.test', displayName: 'Asha V' });
    expect(calls[0].headers.APIKEY).toBe(KEY);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('treats an error code inside an HTTP 200 as an error', async () => {
    const { adapter } = fake(() => json(200, { responseCode: 401, message: `You're not authorized ${KEY}` }));
    const error = await adapter.verifyCredential(cred).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect((error as ProviderApiError).kind).toBe('INVALID_CREDENTIAL');
    expect((error as ProviderApiError).message).not.toContain(KEY);
  });

  it('tries the EU region when the US one does not know the key, then stays there', async () => {
    const { calls, adapter } = fake(({ url }) =>
      url.startsWith(EU)
        ? json(200, { responseCode: 200, content: { username: 'eu-user' } })
        : json(401, { responseCode: 401, message: 'not authorized' }),
    );
    await expect(adapter.verifyCredential(cred)).resolves.toMatchObject({ externalAccountId: 'eu-user' });
    await adapter.verifyCredential(cred);
    expect(calls.map((c) => c.url.startsWith(EU))).toEqual([false, true, true]);
  });

  it('does not fall through to another region for errors other than a bad key', async () => {
    const { calls, adapter } = fake(() => json(500, { responseCode: 500 }));
    await expect(adapter.verifyCredential(cred)).rejects.toMatchObject({ kind: 'PROVIDER_UNAVAILABLE' });
    expect(calls).toHaveLength(1);
  });
});

describe('Jotform webhooks', () => {
  const OURS = 'https://app.test/ingest/v1/jotform/tok_abc';
  const OTHER = 'https://zapier.test/hook';

  it('lists webhooks with the URL as their id', async () => {
    const { adapter } = fake(() => json(200, { responseCode: 200, content: { '0': OTHER, '1': OURS } }));
    const hooks = await adapter.listWebhooks(cred, '42');
    expect(hooks.map((h) => h.externalWebhookId)).toEqual([OTHER, OURS]);
  });

  it('adds a webhook form-encoded, and does not add it twice', async () => {
    let installed: string[] = [];
    const { calls, adapter } = fake(({ method, body }) => {
      if (method === 'POST') installed = [...installed, new URLSearchParams(body).get('webhookURL')!];
      return json(200, { responseCode: 200, content: Object.fromEntries(installed.map((u, i) => [String(i), u])) });
    });
    const hook = await adapter.installWebhook(cred, { externalFormId: '42', url: OURS, signingSecret: null, externalRef: 'src_1' });
    await adapter.installWebhook(cred, { externalFormId: '42', url: OURS, signingSecret: null, externalRef: 'src_1' });
    expect(hook.externalWebhookId).toBe(OURS);
    expect(installed).toEqual([OURS]);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${US}/form/42/webhooks`);
    expect(post.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('removes every copy of our URL by its current index, highest first', async () => {
    const { calls, adapter } = fake(({ method }) =>
      method === 'DELETE'
        ? json(200, { responseCode: 200, content: {} })
        : json(200, { responseCode: 200, content: { '0': OURS, '1': OTHER, '2': OURS } }),
    );
    await adapter.uninstallWebhook(cred, { externalFormId: '42', externalWebhookId: OURS });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `${US}/form/42/webhooks/2`,
      `${US}/form/42/webhooks/0`,
    ]);
  });

  it('pages forms by offset and leaves deleted forms out', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: `F${i}`, status: i === 0 ? 'DELETED' : 'ENABLED', count: '3' }));
    const { adapter } = fake(() => json(200, { responseCode: 200, content: page }));
    const res = await adapter.listForms(cred, null);
    expect(res.items).toHaveLength(99);
    expect(res.items[0]).toMatchObject({ externalFormId: '1', submissionCount: 3, isClosed: false });
    expect(res.nextCursor).toBe('100');
  });
});

describe('a read-only Jotform key', () => {
  it('says to switch the key to Full Access when Jotform refuses a webhook install', async () => {
    const { adapter } = fake(({ method }) =>
      method === 'POST'
        ? json(403, { responseCode: 403, message: 'You are not allowed', content: '' })
        : json(200, { responseCode: 200, content: [] }),
    );
    const error = await adapter
      .installWebhook(cred, { externalFormId: '42', url: 'https://app.test/x', signingSecret: null, externalRef: 'r' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'FORBIDDEN' });
    expect((error as Error).message).toContain('Full Access');
  });
});

describe('a delete with no region remembered yet', () => {
  it('finds an EU key’s region on the delete itself, with no extra lookup', async () => {
    const { calls, adapter } = fake(({ url, method }) => {
      if (!url.startsWith(EU)) return json(401, { responseCode: 401 });
      return method === 'DELETE'
        ? json(200, { responseCode: 200, content: {} })
        : json(200, { responseCode: 200, content: { '0': 'https://app.test/x' } });
    });
    await adapter.uninstallWebhook(cred, { externalFormId: '42', externalWebhookId: 'https://app.test/x' });
    expect(calls.map((c) => `${c.method} ${c.url.startsWith(EU) ? 'EU' : 'US'}`)).toEqual(['GET US', 'GET EU', 'DELETE EU']);
    expect(calls.some((c) => c.url.endsWith('/user'))).toBe(false);
  });
});

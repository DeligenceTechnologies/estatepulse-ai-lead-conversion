import { describe, expect, it, vi } from 'vitest';
import { TypeformClient, type FetchLike } from './typeform.client';
import { TypeformProviderAdapter } from './typeform.provider';
import { ProviderApiError } from '../types';

const KEY = 'tfp_supersecret_do_not_leak_0001';
const cred = { apiKey: KEY };

/** Builds an adapter whose fetch returns scripted responses, in order. */
function adapterWith(...responses: Array<Partial<Response> | (() => never)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;

  const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (typeof next === 'function') next();
    return next as Response;
  }) as unknown as FetchLike;

  return { adapter: new TypeformProviderAdapter(new TypeformClient('https://api.test', 1000, fetchFn)), calls };
}

const ok = (body: unknown): Partial<Response> => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  headers: new Headers(),
});

const fail = (status: number, body = 'nope'): Partial<Response> => ({
  ok: false,
  status,
  text: async () => body,
  headers: new Headers(),
});

describe('TypeformProviderAdapter — happy paths', () => {
  it('verifies a credential and labels the account', async () => {
    const { adapter, calls } = adapterWith(ok({ user_id: 'usr_1', email: 'a@b.com', alias: 'A B' }));
    const acct = await adapter.verifyCredential(cred);

    expect(acct).toEqual({ externalAccountId: 'usr_1', email: 'a@b.com', displayName: 'A B' });
    expect(calls[0].url).toBe('https://api.test/me');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('pages forms with an opaque cursor and reads closed forms off is_public', async () => {
    const { adapter, calls } = adapterWith(
      ok({
        page_count: 2,
        items: [
          { id: 'abc123', title: 'Lead form', last_updated_at: '2026-09-01T00:00:00Z', settings: { is_public: true } },
          { id: 'def456', title: 'Old form', settings: { is_public: false } },
        ],
      }),
    );
    const page = await adapter.listForms(cred);

    expect(calls[0].url).toBe('https://api.test/forms?page=1&page_size=200');
    expect(page.items[0]).toMatchObject({ externalFormId: 'abc123', name: 'Lead form', isClosed: false });
    expect(page.items[1]).toMatchObject({ externalFormId: 'def456', isClosed: true });
    expect(page.nextCursor).toBe('2');
  });

  it('stops paging on the last page', async () => {
    const { adapter } = adapterWith(ok({ page_count: 1, items: [] }));
    expect((await adapter.listForms(cred)).nextCursor).toBeNull();
  });

  it('describeForm reads fields and choices from one call, flattening groups', async () => {
    const { adapter, calls } = adapterWith(
      ok({
        fields: [
          {
            id: 'grp',
            type: 'group',
            title: 'About you',
            properties: { fields: [{ id: 'f_email', ref: 'email', type: 'email', title: 'Email' }] },
          },
          {
            id: 'f_when',
            type: 'dropdown',
            title: 'When are you hoping to move?',
            properties: { choices: [{ id: 'c1', ref: 'r1', label: '1-3 months' }] },
          },
          { id: 'f_legal', type: 'legal', title: 'Terms' },
          { id: 'f_stmt', type: 'statement', title: 'Welcome!' },
        ],
      }),
    );

    const fields = await adapter.describeForm(cred, 'abc123');

    expect(calls.map((c) => c.url)).toEqual(['https://api.test/forms/abc123']);
    expect(fields.map((f) => f.key)).toEqual(['f_email', 'f_when', 'f_legal']);
    expect(fields[1].options).toEqual([{ id: 'c1', text: '1-3 months' }]);
    expect(fields[2].booleanOptIn).toBe(true);
    expect(fields[0].booleanOptIn).toBe(false);
  });

  it('lists a form\'s webhooks with the tag as both id and external ref', async () => {
    const { adapter, calls } = adapterWith(
      ok({ items: [{ id: 'wh_1', form_id: 'abc123', tag: 'ls-1', url: 'https://us/a', enabled: true }] }),
    );

    const hooks = await adapter.listWebhooks(cred, 'abc123');
    expect(calls[0].url).toBe('https://api.test/forms/abc123/webhooks');
    expect(hooks).toEqual([
      { externalFormId: 'abc123', externalWebhookId: 'ls-1', url: 'https://us/a', isEnabled: true, externalRef: 'ls-1' },
    ]);
  });

  it('installs with a PUT to the tag, with the exact body Typeform expects', async () => {
    const { adapter, calls } = adapterWith(
      ok({ id: 'wh_1', form_id: 'abc123', tag: 'ls-42', url: 'https://us/ingest', enabled: true, secret: 'whsec_abc' }),
    );

    const created = await adapter.installWebhook(cred, {
      externalFormId: 'abc123',
      url: 'https://us/ingest',
      signingSecret: 'whsec_abc',
      externalRef: 'ls-42',
    });

    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].url).toBe('https://api.test/forms/abc123/webhooks/ls-42');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      url: 'https://us/ingest',
      enabled: true,
      verify_ssl: true,
      secret: 'whsec_abc',
    });
    expect(created).toMatchObject({ externalWebhookId: 'ls-42', externalFormId: 'abc123', externalRef: 'ls-42' });
    // The echoed secret never leaves the adapter.
    expect(JSON.stringify(created)).not.toContain('whsec_abc');
  });

  it('omits the secret entirely when none is given', async () => {
    const { adapter, calls } = adapterWith(ok({ tag: 'r', form_id: 'f', url: 'u' }));
    await adapter.installWebhook(cred, { externalFormId: 'f', url: 'u', signingSecret: null, externalRef: 'r' });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('secret');
  });

  it('a full update PUTs straight away; a partial one reads the webhook first', async () => {
    const full = adapterWith(ok({ tag: 'r', form_id: 'f', url: 'https://new', enabled: true }));
    await full.adapter.updateWebhook(
      cred,
      { externalFormId: 'f', externalWebhookId: 'r' },
      { url: 'https://new', isEnabled: true, signingSecret: 'whsec_x' },
    );
    expect(full.calls).toHaveLength(1);
    expect(JSON.parse(full.calls[0].init.body as string)).toEqual({
      url: 'https://new',
      enabled: true,
      verify_ssl: true,
      secret: 'whsec_x',
    });

    const partial = adapterWith(
      ok({ tag: 'r', form_id: 'f', url: 'https://old', enabled: false }),
      ok({ tag: 'r', form_id: 'f', url: 'https://old', enabled: true }),
    );
    const hook = await partial.adapter.updateWebhook(cred, { externalFormId: 'f', externalWebhookId: 'r' }, { isEnabled: true });
    expect(partial.calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(partial.calls[1].init.body as string)).toMatchObject({ url: 'https://old', enabled: true });
    expect(hook.isEnabled).toBe(true);
  });

  it('uninstalls by DELETE to the tag, and something already gone resolves', async () => {
    const { adapter, calls } = adapterWith(fail(404));
    await expect(
      adapter.uninstallWebhook(cred, { externalFormId: 'f', externalWebhookId: 'ls-gone' }),
    ).resolves.toBeUndefined();
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe('https://api.test/forms/f/webhooks/ls-gone');
  });
});

describe('TypeformProviderAdapter — failure paths', () => {
  it('maps a 401 to INVALID_CREDENTIAL, named as Typeform, with the token redacted', async () => {
    const { adapter } = adapterWith(fail(401, `bad token ${KEY} tfp_another_leak_00000000`));
    const err = await adapter.verifyCredential(cred).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect(err.kind).toBe('INVALID_CREDENTIAL');
    expect(err.provider).toBe('TYPEFORM');
    expect(err.message).toContain('Typeform rejected');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('tfp_another');
  });

  it('rejects an install that returns no tag — we could never manage it', async () => {
    const { adapter } = adapterWith(ok({ url: 'https://us/ingest' }));
    const err = await adapter
      .installWebhook(cred, { externalFormId: 'f', url: 'u', signingSecret: null, externalRef: 'r' })
      .catch((e) => e);
    expect(err.kind).toBe('UNEXPECTED_RESPONSE');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { TallyClient, type FetchLike } from './tally.client';
import { TallyProviderAdapter } from './tally.provider';
import { ProviderApiError } from '../types';

const KEY = 'tly-supersecret-do-not-leak-0001';
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

  return { adapter: new TallyProviderAdapter(new TallyClient('https://api.test', 1000, fetchFn)), calls };
}

const ok = (body: unknown): Partial<Response> => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  headers: new Headers(),
});

const fail = (status: number, body = 'nope', headers: Record<string, string> = {}): Partial<Response> => ({
  ok: false,
  status,
  text: async () => body,
  headers: new Headers(headers),
});

describe('TallyProviderAdapter — happy paths', () => {
  it('verifies a credential and labels the account', async () => {
    const { adapter, calls } = adapterWith(ok({ id: 'usr_1', email: 'a@b.com', fullName: 'A B' }));
    const acct = await adapter.verifyCredential(cred);

    expect(acct).toEqual({ externalAccountId: 'usr_1', email: 'a@b.com', displayName: 'A B' });
    expect(calls[0].url).toBe('https://api.test/users/me');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('pages forms with an opaque cursor', async () => {
    const { adapter } = adapterWith(
      ok({ items: [{ id: 'lbxX8o', name: 'Lead generation form', status: 'PUBLISHED', numberOfSubmissions: 1 }], hasMore: true }),
    );
    const page = await adapter.listForms(cred);

    expect(page.items[0]).toMatchObject({ externalFormId: 'lbxX8o', submissionCount: 1, isClosed: false });
    expect(page.nextCursor).toBe('2');
  });

  it('stops paging when hasMore is false', async () => {
    const { adapter } = adapterWith(ok({ items: [], hasMore: false }));
    expect((await adapter.listForms(cred)).nextCursor).toBeNull();
  });

  it('describeForm calls BOTH endpoints and merges questions with option blocks', async () => {
    const { adapter, calls } = adapterWith(
      ok({
        questions: [
          {
            id: 'YzPeeJ',
            type: 'MULTIPLE_CHOICE',
            title: 'When are you hoping to move?',
            fields: [{ uuid: 'grp-1', blockGroupUuid: 'grp-1' }],
          },
        ],
      }),
      ok({
        blocks: [
          { type: 'MULTIPLE_CHOICE_OPTION', uuid: 'o1', groupUuid: 'grp-1', payload: { index: 0, text: '1-3 months' } },
        ],
      }),
    );

    const fields = await adapter.describeForm(cred, 'lbxX8o');

    const urls = calls.map((c) => c.url).sort();
    expect(urls).toEqual(['https://api.test/forms/lbxX8o', 'https://api.test/forms/lbxX8o/questions']);
    expect(fields[0].key).toBe('question_YzPeeJ');
    expect(fields[0].options).toEqual([{ id: 'o1', text: '1-3 months' }]);
  });

  it('filters the account-wide webhook list down to one form', async () => {
    const { adapter } = adapterWith(
      ok({
        webhooks: [
          { id: 'w1', formId: 'lbxX8o', url: 'https://us/a', isEnabled: true, externalSubscriber: 'ls-1' },
          { id: 'w2', formId: 'OTHER', url: 'https://us/b', isEnabled: true },
        ],
        hasMore: false,
      }),
    );

    const hooks = await adapter.listWebhooks(cred, 'lbxX8o');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ externalWebhookId: 'w1', externalRef: 'ls-1' });
  });

  it('never surfaces the signingSecret Tally returns in its webhook list', async () => {
    const { adapter } = adapterWith(
      ok({ webhooks: [{ id: 'w1', formId: 'f', url: 'u', signingSecret: 'whsec_LEAKED' }], hasMore: false }),
    );
    const hooks = await adapter.listWebhooks(cred, 'f');
    expect(JSON.stringify(hooks)).not.toContain('whsec_LEAKED');
  });

  it('installs with the exact body Tally expects', async () => {
    const { adapter, calls } = adapterWith(ok({ id: 'wh_1', url: 'https://us/ingest', isEnabled: true }));

    const created = await adapter.installWebhook(cred, {
      externalFormId: 'lbxX8o',
      url: 'https://us/ingest',
      signingSecret: 'whsec_abc',
      externalRef: 'ls-42',
    });

    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      formId: 'lbxX8o',
      url: 'https://us/ingest',
      eventTypes: ['FORM_RESPONSE'],
      signingSecret: 'whsec_abc',
      externalSubscriber: 'ls-42',
    });
    // formId is absent from the create response; it must still come back.
    expect(created).toMatchObject({ externalWebhookId: 'wh_1', externalFormId: 'lbxX8o' });
  });

  it('omits signingSecret entirely when a provider cannot sign', async () => {
    const { adapter, calls } = adapterWith(ok({ id: 'wh_1', url: 'u' }));
    await adapter.installWebhook(cred, {
      externalFormId: 'f',
      url: 'u',
      signingSecret: null,
      externalRef: 'ls-1',
    });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('signingSecret');
  });
});

describe('TallyProviderAdapter — failure paths', () => {
  const cases: [number, string, boolean][] = [
    // status, expected kind, mayHaveExecuted
    [401, 'INVALID_CREDENTIAL', false],
    [403, 'FORBIDDEN', false],
    [404, 'NOT_FOUND', false],
    [422, 'INVALID_REQUEST', false],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
  ];

  it.each(cases)('maps HTTP %i to %s', async (status, kind, mayHaveExecuted) => {
    const { adapter } = adapterWith(fail(status));
    const err = await adapter.verifyCredential(cred).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect(err.kind).toBe(kind);
    // This is the property connect() branches on to decide rollback vs reconcile.
    expect(err.mayHaveExecuted).toBe(mayHaveExecuted);
  });

  it('retries a 429 once, honouring Retry-After, then succeeds', async () => {
    const { adapter, calls } = adapterWith(fail(429, 'slow down', { 'retry-after': '0' }), ok({ id: 'usr_1' }));
    const acct = await adapter.verifyCredential(cred);

    expect(acct.externalAccountId).toBe('usr_1');
    expect(calls).toHaveLength(2);
  });

  it('surfaces a second 429 rather than retrying forever', async () => {
    const { adapter, calls } = adapterWith(fail(429, 'slow down', { 'retry-after': '0' }));
    const err = await adapter.verifyCredential(cred).catch((e) => e);

    expect(err.kind).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(2); // original + one retry, no more
  });

  it('treats a network failure as "might have executed"', async () => {
    const { adapter } = adapterWith(() => {
      throw new Error('socket hang up');
    });
    const err = await adapter.verifyCredential(cred).catch((e) => e);

    expect(err.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(err.mayHaveExecuted).toBe(true);
  });

  it('treats an unreadable 2xx as unexpected, not as success', async () => {
    const { adapter } = adapterWith({ ok: true, status: 200, text: async () => '<html>oops', headers: new Headers() });
    const err = await adapter.verifyCredential(cred).catch((e) => e);
    expect(err.kind).toBe('UNEXPECTED_RESPONSE');
  });

  it('rejects an install that returns no id — we could never manage it', async () => {
    const { adapter } = adapterWith(ok({ url: 'https://us/ingest' }));
    const err = await adapter
      .installWebhook(cred, { externalFormId: 'f', url: 'u', signingSecret: null, externalRef: 'r' })
      .catch((e) => e);

    expect(err.kind).toBe('UNEXPECTED_RESPONSE');
  });

  it('uninstalling something already gone resolves instead of throwing', async () => {
    const { adapter } = adapterWith(fail(404));
    await expect(
      adapter.uninstallWebhook(cred, { externalFormId: 'f', externalWebhookId: 'wh_gone' }),
    ).resolves.toBeUndefined();
  });

  /**
   * An error message is the easiest place for a credential to end up in a log
   * that outlives it. Checked on every failure path, not just one.
   */
  it.each([401, 403, 404, 422, 429, 500])('never leaks the API key in a %i error', async (status) => {
    const { adapter } = adapterWith(fail(status, `request with Bearer ${KEY} failed`));
    const err = await adapter.verifyCredential(cred).catch((e) => e);

    const serialized = `${err.message} ${JSON.stringify(err)} ${err.stack ?? ''}`;
    expect(serialized).not.toContain(KEY);
  });
});

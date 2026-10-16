import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrmApiError } from '../types';
import { HubSpotClient } from './hubspot.client';
import { modifiedAtMs, toCrmContact } from './hubspot-contacts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SECRET = 'hubspot-secret-DO-NOT-LEAK';
const client = (extra: Record<string, string> = {}) =>
  new HubSpotClient(
    new ConfigService({
      HUBSPOT_CLIENT_ID: 'client-1',
      HUBSPOT_CLIENT_SECRET: SECRET,
      PUBLIC_APP_URL: 'http://localhost:3000',
      PUBLIC_API_BASE_URL: 'https://api.example.com',
      HUBSPOT_RETRY_BASE_MS: '1',
      ...extra,
    }),
  );

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const allUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).join('\n');

describe('authorizeUrl', () => {
  it('asks for the read scope with our state and redirect — and never carries the secret', () => {
    const url = new URL(client().authorizeUrl('STATE-1'));
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('oauth crm.objects.contacts.read');
    expect(url.searchParams.get('state')).toBe('STATE-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/oauth/hubspot-callback.html');
    expect(url.toString()).not.toContain(SECRET);
  });

  it('takes HUBSPOT_SCOPES and HUBSPOT_REDIRECT_URI verbatim', () => {
    const url = new URL(client({ HUBSPOT_SCOPES: 'oauth  crm.objects.contacts.read   crm.objects.owners.read', HUBSPOT_REDIRECT_URI: 'https://app.example.com/cb.html' }).authorizeUrl('s'));
    expect(url.searchParams.get('scope')).toBe('oauth crm.objects.contacts.read crm.objects.owners.read');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb.html');
  });

  it('is not configured without both client id and secret', () => {
    expect(client().isConfigured()).toBe(true);
    expect(client({ HUBSPOT_CLIENT_SECRET: '' }).isConfigured()).toBe(false);
  });
});

describe('token endpoint', () => {
  it('posts the code and secret to the date-versioned endpoint, in the body — never the URL', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'AT', refresh_token: 'RT', expires_in: 1800, token_type: 'bearer', scopes: ['oauth', 'crm.objects.contacts.read'] }));
    const t = await client().exchangeCode('CODE-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/oauth/2026-09/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE-1');
    expect(body.get('client_secret')).toBe(SECRET);
    expect(body.get('redirect_uri')).toBe('http://localhost:3000/oauth/hubspot-callback.html');
    expect(allUrls()).not.toContain('CODE-1');
    expect(allUrls()).not.toContain(SECRET);
    expect(t).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 1800, scopes: ['oauth', 'crm.objects.contacts.read'] });
  });

  it('a dead refresh token is REAUTH, and its error never carries the token', async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant', status: 'BAD_REFRESH_TOKEN', message: 'refresh token is invalid' }, 400));
    const err = (await client().refresh('RT-SECRET-VALUE').catch((e) => e)) as CrmApiError;
    expect(err).toBeInstanceOf(CrmApiError);
    expect(err.kind).toBe('REAUTH');
    expect(err.message).not.toContain('RT-SECRET-VALUE');
  });

  it('a 5xx from the token endpoint is transient', async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    const err = (await client().refresh('RT').catch((e) => e)) as CrmApiError;
    expect(err.kind).toBe('UNAVAILABLE');
    expect(err.transient).toBe(true);
  });
});

describe('identify', () => {
  it('introspects with the token in the POST body, and reads account, domain, user and scopes', async () => {
    fetchMock.mockResolvedValue(json({ active: true, hub_id: 4242, hub_domain: 'acme.hubspot.com', user: 'owner@acme.test', scopes: ['crm.objects.contacts.read'] }));
    const a = await client().identify('ACCESS-TOKEN-VALUE');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/oauth/2026-09/token/introspect');
    expect(new URLSearchParams(init.body).get('token')).toBe('ACCESS-TOKEN-VALUE');
    expect(allUrls()).not.toContain('ACCESS-TOKEN-VALUE');
    expect(a).toEqual({ externalAccountId: '4242', accountName: 'acme.hubspot.com', userEmail: 'owner@acme.test', scopes: ['crm.objects.contacts.read'] });
  });

  it('an inactive token is REAUTH', async () => {
    fetchMock.mockResolvedValue(json({ active: false }));
    expect(((await client().identify('x').catch((e) => e)) as CrmApiError).kind).toBe('REAUTH');
  });
});

describe('retries and rate limits', () => {
  const page = { results: [{ id: '1', properties: { firstname: 'A', email: 'a@x.test' } }] };

  it('retries a 10-second rate limit after the Retry-After it was given, then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'error', policyName: 'TEN_SECONDLY_ROLLING' }, 429, { 'retry-after': '0' })).mockResolvedValueOnce(json(page));
    const r = await client().listContacts('AT', null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.contacts).toHaveLength(1);
  });

  it('does not retry the daily limit in-request: it hands back an hour-long wait', async () => {
    fetchMock.mockResolvedValue(json({ status: 'error', policyName: 'DAILY', message: 'You have reached your daily limit.' }, 429));
    const err = (await client().listContacts('AT', null).catch((e) => e)) as CrmApiError;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBe(3_600_000);
  });

  it('hands a long Retry-After back to the caller instead of sleeping on it', async () => {
    fetchMock.mockResolvedValue(json({ policyName: 'TEN_SECONDLY_ROLLING' }, 429, { 'retry-after': '120' }));
    const err = (await client().listContacts('AT', null).catch((e) => e)) as CrmApiError;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('retries a 5xx a bounded number of times, then reports UNAVAILABLE', async () => {
    fetchMock.mockResolvedValue(json({ message: 'oops' }, 502));
    const err = (await client().listContacts('AT', null).catch((e) => e)) as CrmApiError;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err.kind).toBe('UNAVAILABLE');
  });

  it('retries a dropped connection, then reports UNAVAILABLE without the URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = (await client().readContacts('AT', ['123']).catch((e) => e)) as CrmApiError;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err.kind).toBe('UNAVAILABLE');
    expect(err.message).not.toContain('123');
  });

  it('never retries a permanent error', async () => {
    for (const [status, kind] of [
      [400, 'BAD_REQUEST'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(json({ message: 'no' }, status));
      const err = (await client().listContacts('AT', null).catch((e) => e)) as CrmApiError;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.kind).toBe(kind);
      expect(err.transient).toBe(false);
    }
  });

  it('a missing scope is REAUTH: only the owner reconnecting fixes it', async () => {
    fetchMock.mockResolvedValue(json({ category: 'MISSING_SCOPES', message: 'This app hasn\'t been granted all required scopes' }, 403));
    expect(((await client().listContacts('AT', null).catch((e) => e)) as CrmApiError).kind).toBe('REAUTH');
  });
});

describe('reading contacts', () => {
  it('lists a page of non-archived contacts with the properties we map, and follows the cursor', async () => {
    fetchMock.mockResolvedValue(json({ results: [{ id: '7', properties: { firstname: 'Ann' } }], paging: { next: { after: '7' } } }));
    const r = await client().listContacts('AT', 'CURSOR-1');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/crm/objects/2026-09/contacts');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('after')).toBe('CURSOR-1');
    expect(url.searchParams.get('archived')).toBe('false');
    expect(url.searchParams.get('properties')!.split(',')).toEqual(expect.arrayContaining(['firstname', 'lastname', 'email', 'phone', 'mobilephone']));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer AT');
    expect(r.nextCursor).toBe('7');
  });

  it('batch-reads by id; ids not returned (deleted, archived, merged) are missing', async () => {
    fetchMock.mockResolvedValue(json({ results: [{ id: '1', properties: { email: 'a@x.test' } }, { id: '3', archived: true, properties: {} }] }, 207));
    const r = await client().readContacts('AT', ['1', '2', '3', '1']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.inputs).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(r.found.map((c) => c.externalId)).toEqual(['1']);
    expect(r.missing).toEqual(['2', '3']);
  });

  it('searches by last-modified, oldest first, and stops before the 10,000-result wall', async () => {
    fetchMock.mockResolvedValue(json({ results: [], paging: { next: { after: '9900' } } }));
    const r = await client().changedContactsSince('AT', 1_700_000_000_000, '9700');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.filterGroups[0].filters[0]).toEqual({ propertyName: 'lastmodifieddate', operator: 'GTE', value: '1700000000000' });
    expect(body.sorts).toEqual([{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }]);
    expect(body.after).toBe('9700');
    expect(r.capped).toBe(true);
    expect(r.nextCursor).toBeNull();
  });
});

describe('toCrmContact', () => {
  it('maps names, email and a phone — falling back to the mobile — and labels HubSpot’s own fields', () => {
    const c = toCrmContact({ id: '9', properties: { firstname: ' Ann ', lastname: '', email: 'ann@x.test', phone: null, mobilephone: '512 555 0102', lifecyclestage: 'marketingqualifiedlead', hs_lead_status: 'IN_PROGRESS' } });
    expect(c).toEqual({
      externalId: '9',
      firstName: 'Ann',
      lastName: null,
      email: 'ann@x.test',
      phone: '512 555 0102',
      extra: { 'HubSpot lifecycle stage': 'Marketing Qualified Lead', 'HubSpot lead status': 'In Progress' },
    });
  });

  it('passes a custom lifecycle stage through untouched', () => {
    expect(toCrmContact({ id: '9', properties: { lifecyclestage: '1234567' } }).extra['HubSpot lifecycle stage']).toBe('1234567');
  });

  it('reads the modified date as ISO or as epoch ms', () => {
    expect(modifiedAtMs({ id: '1', properties: { lastmodifieddate: '2026-10-01T00:00:00.000Z' } })).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
    expect(modifiedAtMs({ id: '1', properties: { lastmodifieddate: '1759276800000' } })).toBe(1759276800000);
    expect(modifiedAtMs({ id: '1', properties: {} })).toBe(0);
  });
});

describe('revoke and uninstall', () => {
  it('revokes with the token in the body; an already-dead token is fine', async () => {
    fetchMock.mockResolvedValue(json({}, 400));
    await client().revoke('RT-VALUE');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/oauth/2026-09/token/revoke');
    expect(new URLSearchParams(init.body).get('token')).toBe('RT-VALUE');
  });

  it('uninstalls with DELETE and a bearer token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await client().uninstall('AT');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/appinstalls/2026-09/external-install');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('webhookUrl', () => {
  it('defaults to the public API base, and takes HUBSPOT_WEBHOOK_URL verbatim', () => {
    expect(client().webhookUrl).toBe('https://api.example.com/ingest/v1/crm/hubspot/webhook');
    expect(client({ HUBSPOT_WEBHOOK_URL: 'https://hooks.example.com/hs' }).webhookUrl).toBe('https://hooks.example.com/hs');
  });
});

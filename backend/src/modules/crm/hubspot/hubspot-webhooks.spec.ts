import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_SKEW_MS, dedupeKeyFor, parseDelivery, signedUri, verifySignatureV3 } from './hubspot-webhooks';

const SECRET = 'hubspot-client-secret';
const URL_REGISTERED = 'https://api.example.com/ingest/v1/crm/hubspot/webhook';
const NOW = 1_760_000_000_000;

/** What HubSpot sends: base64(HMAC-SHA256(secret, method + uri + body + timestamp)). */
function sign(body: string, ts: number, uri = URL_REGISTERED, method = 'POST', secret = SECRET): string {
  return createHmac('sha256', secret).update(`${method}${uri}${body}${ts}`, 'utf8').digest('base64');
}

const event = (over: Record<string, unknown> = {}) => ({
  eventId: 100,
  subscriptionId: 7,
  portalId: 4242,
  appId: 1,
  occurredAt: NOW - 1000,
  subscriptionType: 'contact.propertyChange',
  attemptNumber: 0,
  objectId: 501,
  propertyName: 'email',
  propertyValue: 'secret.person@example.com',
  changeSource: 'CRM',
  ...over,
});

describe('verifySignatureV3', () => {
  const body = JSON.stringify([event()]);
  const check = (over: Partial<Parameters<typeof verifySignatureV3>[0]> = {}) =>
    verifySignatureV3({
      method: 'POST',
      uri: URL_REGISTERED,
      rawBody: Buffer.from(body),
      signature: sign(body, NOW),
      timestamp: String(NOW),
      clientSecret: SECRET,
      now: NOW,
      ...over,
    });

  it('accepts HubSpot’s signature over the exact bytes', () => {
    expect(check()).toBe('VALID');
  });

  it('refuses a body changed by even one byte', () => {
    expect(check({ rawBody: Buffer.from(body.replace('4242', '4243')) })).toBe('INVALID');
  });

  it('refuses re-serialised JSON: whitespace is part of what was signed', () => {
    expect(check({ rawBody: Buffer.from(JSON.stringify(JSON.parse(body), null, 1)) })).toBe('INVALID');
  });

  it('refuses another secret, method or URL', () => {
    expect(check({ clientSecret: 'other' })).toBe('INVALID');
    expect(check({ method: 'PUT' })).toBe('INVALID');
    expect(check({ uri: 'https://evil.example.com/ingest/v1/crm/hubspot/webhook' })).toBe('INVALID');
  });

  it('refuses a timestamp more than five minutes old — or ahead — so a capture cannot be replayed later', () => {
    expect(check({ now: NOW + MAX_SKEW_MS + 1 })).toBe('STALE');
    expect(check({ now: NOW - MAX_SKEW_MS - 1 })).toBe('STALE');
    expect(check({ now: NOW + MAX_SKEW_MS - 1 })).toBe('VALID');
  });

  it('refuses a request whose signed timestamp was swapped for a fresh one', () => {
    expect(check({ timestamp: String(NOW + 1000), now: NOW + 1000 })).toBe('INVALID');
  });

  it('reports missing headers, a missing secret, and garbage without throwing', () => {
    expect(check({ signature: undefined })).toBe('MISSING');
    expect(check({ timestamp: undefined })).toBe('MISSING');
    expect(check({ clientSecret: '' })).toBe('MISSING');
    expect(check({ timestamp: 'yesterday' })).toBe('STALE');
    expect(check({ signature: '%%%not-base64' })).toBe('INVALID');
  });
});

describe('signedUri', () => {
  it('takes origin and path from the registered URL, not from the request’s Host', () => {
    expect(signedUri(URL_REGISTERED, '/internal/prefix/ingest/v1/crm/hubspot/webhook')).toBe(URL_REGISTERED);
  });

  it('decodes HubSpot’s listed escapes in the query string only, and drops a fragment', () => {
    expect(signedUri(URL_REGISTERED, '/x?a=%3A%2F%3F%40%21%24%27%28%29%2A%2C%3B&b=%20#frag')).toBe(`${URL_REGISTERED}?a=:/?@!$'()*,;&b=%20`);
  });
});

describe('parseDelivery', () => {
  it('keeps identifiers and drops propertyValue — no personal data is stored', () => {
    const parsed = parseDelivery([event()]);
    if ('error' in parsed) throw new Error(parsed.error);
    const [e] = parsed.events;
    expect(e.portalId).toBe('4242');
    expect(e.contactIds).toEqual(['501']);
    expect(JSON.stringify(e.stored)).not.toContain('secret.person');
  });

  it('a merge refreshes every contact involved', () => {
    const parsed = parseDelivery([event({ subscriptionType: 'contact.merge', objectId: 1, primaryObjectId: 1, mergedObjectIds: [2, 3], newObjectId: 4 })]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.events[0].contactIds.sort()).toEqual(['1', '2', '3', '4']);
  });

  it('acts on contact events only: association changes, other objects and unknown types are not acted on', () => {
    const parsed = parseDelivery([
      event({ subscriptionType: 'contact.associationChange' }),
      event({ subscriptionType: 'deal.creation' }),
      event({ subscriptionType: 'object.creation', objectTypeId: '0-3' }),
      event({ subscriptionType: 'object.creation' }),
      event({ subscriptionType: 'object.propertyChange', objectTypeId: '0-1', objectId: 9 }),
      event({ subscriptionType: undefined, eventType: 'contact.deletion', objectId: 8 }),
    ]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.events.map((e) => e.contactIds)).toEqual([[], [], [], [], ['9'], ['8']]);
  });

  it('gives a retry the same dedupe key, and a different event a different one', () => {
    const parsed = parseDelivery([event({ attemptNumber: 0 }), event({ attemptNumber: 3 }), event({ propertyName: 'phone' }), event({ eventId: 101 })]);
    if ('error' in parsed) throw new Error(parsed.error);
    const [a, retry, otherProperty, otherEvent] = parsed.events.map((e) => e.dedupeKey);
    expect(retry).toBe(a);
    expect(otherProperty).not.toBe(a);
    expect(otherEvent).not.toBe(a);
    expect(a).toMatch(/^hs:[0-9a-f]{64}$/);
    expect(a.length).toBeLessThanOrEqual(128);
  });

  it('dedupes on the whole event, because HubSpot says eventId alone is not unique', () => {
    const base = { eventId: '1', portalId: '1', occurredAt: 1 } as Parameters<typeof dedupeKeyFor>[0];
    expect(dedupeKeyFor({ ...base, objectId: '5' }, 'contact.creation')).not.toBe(dedupeKeyFor({ ...base, objectId: '6' }, 'contact.creation'));
  });

  it('refuses what is not a HubSpot delivery', () => {
    for (const bad of [{}, [], [{ portalId: 1 }], [event({ portalId: 'abc' })], 'x', null]) {
      expect('error' in parseDelivery(bad)).toBe(true);
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSpotClient } from './hubspot.client';

describe('HubSpotClient.updateContact', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('PATCHes only the properties sent and hands back the contact as HubSpot now holds it', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: '901', properties: { firstname: 'Ana', phone: '+14155550199', email: 'ana@example.test' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new HubSpotClient({ get: () => undefined } as any);

    const contact = await client.updateContact('tok', '901', { phone: '+14155550199' });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/crm\/objects\/[^/]+\/contacts\/901$/);
    expect(init).toMatchObject({ method: 'PATCH', headers: { Authorization: 'Bearer tok' } });
    expect(JSON.parse(String(init.body))).toEqual({ properties: { phone: '+14155550199' } });
    expect(contact).toMatchObject({ externalId: '901', phone: '+14155550199', email: 'ana@example.test' });
  });

  it('asks for the write scope on new connections, without requiring it of old ones', () => {
    const client = new HubSpotClient({ get: () => undefined } as any);
    expect(client.scopes.split(' ')).toContain('crm.objects.contacts.write');
    expect(client.requiredScopes).not.toContain('crm.objects.contacts.write');
  });
});

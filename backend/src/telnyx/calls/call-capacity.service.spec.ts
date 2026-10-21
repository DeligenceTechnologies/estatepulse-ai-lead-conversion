import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallCapacityService, telnyxReason } from './call-capacity.service';

const ORG = 'org-1';

function telnyxResponses(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.telnyx.com/v2', '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    const { status, body } = handler(init);
    return new Response(JSON.stringify(body), { status });
  });
}

function setup(limitInDb = 5) {
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn().mockResolvedValue({ maxConcurrentCalls: limitInDb }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  const creds = {
    getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', connectionId: 'app-1' }),
    ensureConnectionId: vi.fn().mockResolvedValue('app-1'),
  };
  const slots = { inUse: vi.fn().mockResolvedValue(1) };
  return { service: new CallCapacityService(prisma as any, creds as any, slots as any), prisma };
}

const APP = { status: 200, body: { data: { outbound: { outbound_voice_profile_id: 'ovp-1' } } } };

describe('CallCapacityService', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('writes the limit to Telnyx before saving it', async () => {
    const order: string[] = [];
    const fetchMock = telnyxResponses({
      'GET /call_control_applications/app-1': () => APP,
      'PATCH /outbound_voice_profiles/ovp-1': (init) => {
        order.push(`telnyx:${JSON.parse(String(init?.body)).concurrent_call_limit}`);
        return { status: 200, body: { data: {} } };
      },
      'GET /outbound_voice_profiles/ovp-1': () => ({ status: 200, body: { data: { concurrent_call_limit: 8, name: 'estate' } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = setup(8);
    prisma.organizationSetting.upsert.mockImplementation(async () => order.push('db'));

    const status = await service.setLimit(ORG, 8);

    expect(order).toEqual(['telnyx:8', 'db']);
    expect(status).toMatchObject({ appLimit: 8, telnyxLimit: 8, inSync: true, inUse: 1 });
  });

  it('keeps the old value when Telnyx refuses the new one', async () => {
    vi.stubGlobal(
      'fetch',
      telnyxResponses({
        'GET /call_control_applications/app-1': () => APP,
        'PATCH /outbound_voice_profiles/ovp-1': () => ({ status: 422, body: { errors: [{ detail: 'exceeds account channel limit' }] } }),
      }),
    );
    const { service, prisma } = setup();
    const error = await service.setLimit(ORG, 50).catch((e) => e);
    expect(error.message).toBe('exceeds account channel limit');
    expect(error.details).toEqual([{ path: 'maxConcurrentCalls', message: error.message }]);
    expect(prisma.organizationSetting.upsert).not.toHaveBeenCalled();
  });

  it('explains when the Call Control app has no outbound voice profile', async () => {
    vi.stubGlobal(
      'fetch',
      telnyxResponses({ 'GET /call_control_applications/app-1': () => ({ status: 200, body: { data: { outbound: {} } } }) }),
    );
    const { service } = setup();
    await expect(service.setLimit(ORG, 3)).rejects.toThrow(/no Outbound Voice Profile/);
  });

  it('reports drift when Telnyx holds a different limit', async () => {
    vi.stubGlobal(
      'fetch',
      telnyxResponses({
        'GET /call_control_applications/app-1': () => APP,
        'GET /outbound_voice_profiles/ovp-1': () => ({ status: 200, body: { data: { concurrent_call_limit: null, name: 'estate' } } }),
      }),
    );
    const { service } = setup(5);
    expect(await service.status(ORG)).toMatchObject({ appLimit: 5, telnyxLimit: null, inSync: false, connected: true });
  });
});

describe('telnyxReason', () => {
  it('pulls the readable part out of a Telnyx error', () => {
    expect(telnyxReason('Telnyx PATCH /outbound_voice_profiles failed 422: {"errors":[{"code":"10015","title":"Invalid value","detail":"Must be at most 10"}]}')).toBe('Must be at most 10');
    expect(telnyxReason('Telnyx unreachable: timeout')).toBeNull();
  });

  it('reads the detail from a body cut off mid-JSON', () => {
    const cut =
      'Telnyx PATCH /outbound_voice_profiles/3060236055115466666 failed 422: {"errors":[{"code":"10015","title":"Account not level 2 verified",' +
      '"detail":"You\'ve exceeded your concurrent call limit. Please contact Telnyx support if you would like to get this number increased.",' +
      '"source":{"pointer":"/concurrent_call_limit"},"meta":{"url":"https://developers.telnyx.com/docs/overv';
    expect(telnyxReason(cut)).toBe(
      "You've exceeded your concurrent call limit. Please contact Telnyx support if you would like to get this number increased.",
    );
  });
});

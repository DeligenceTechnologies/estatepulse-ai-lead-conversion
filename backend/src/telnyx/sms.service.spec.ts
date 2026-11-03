import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmsService } from './sms.service';

function setup(suppressed: string[]) {
  const prisma = {
    contactSuppression: {
      findMany: vi.fn(async ({ where }: any) => (where.normalizedPhone.in as string[]).filter((p) => suppressed.includes(p)).map((normalizedPhone) => ({ normalizedPhone }))),
    },
  };
  const creds = {
    getCreds: vi.fn(async () => ({ apiKey: 'key', fromNumber: '+17427245092' })),
    keyAccepted: vi.fn(async () => undefined),
    keyRejected: vi.fn(async () => undefined),
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'msg-1' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return { service: new SmsService(creds as any, prisma as any), fetch };
}

describe('SmsService.sendSms', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a number that opted out, whoever sends to it', async () => {
    const s = setup(['+12899174129']);
    await expect(s.service.sendSms('org-1', '+1 (289) 917-4129', 'Hi again!')).rejects.toThrow('asked not to be contacted');
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('still sends the texts the rules require after an opt-out', async () => {
    const s = setup(['+12899174129']);
    expect(await s.service.sendSms('org-1', '+12899174129', "You're unsubscribed", { evenIfOptedOut: true })).toEqual({ id: 'msg-1' });
    expect(s.fetch).toHaveBeenCalledOnce();
  });

  it('sends to any other number', async () => {
    const s = setup(['+12899174129']);
    expect(await s.service.sendSms('org-1', '+15125550188', 'Hi Ana')).toEqual({ id: 'msg-1' });
  });
});

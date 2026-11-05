import { afterEach, describe, expect, it, vi } from 'vitest';
import { OptedOutError, SmsService, isTransientSmsError } from './sms.service';

const US = '+15125550188';
const CA = '+12899174129';

function setup(opts: { suppressed?: string[]; earlierTexts?: number } = {}) {
  const prisma = {
    contactSuppression: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.normalizedPhone.in as string[]).filter((p) => (opts.suppressed ?? []).includes(p)).map((normalizedPhone) => ({ normalizedPhone })),
      ),
    },
    organization: { findUnique: vi.fn(async () => ({ name: 'Skyline Realty' })) },
    message: { count: vi.fn(async () => opts.earlierTexts ?? 0) },
  };
  const creds = {
    getCreds: vi.fn(async () => ({ apiKey: 'key', fromNumber: '+17427245092' })),
    keyAccepted: vi.fn(async () => undefined),
    keyRejected: vi.fn(async () => undefined),
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'msg-1' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const sentText = () => JSON.parse((fetch.mock.calls[0] as any)[1].body).text as string;
  return { service: new SmsService(creds as any, prisma as any), fetch, prisma, sentText };
}

describe('SmsService.sendSms', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a number that opted out, whoever sends to it', async () => {
    const s = setup({ suppressed: [CA] });
    await expect(s.service.sendSms('org-1', '+1 (289) 917-4129', 'Hi again!')).rejects.toThrow('asked not to be contacted');
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('still sends the texts the rules require after an opt-out', async () => {
    const s = setup({ suppressed: [CA] });
    expect(await s.service.sendSms('org-1', CA, "You're unsubscribed", { evenIfOptedOut: true })).toEqual({ id: 'msg-1', text: "You're unsubscribed" });
    expect(s.fetch).toHaveBeenCalledOnce();
  });

  it('sends anything else as it is', async () => {
    const s = setup({ suppressed: [CA] });
    expect(await s.service.sendSms('org-1', US, 'Hi Ana')).toEqual({ id: 'msg-1', text: 'Hi Ana' });
    expect(s.prisma.message.count).not.toHaveBeenCalled();
  });

  describe('an outreach text (SMS01)', () => {
    it('adds the STOP line to the first text to a US number, which already names the brokerage', async () => {
      const s = setup();
      const sent = await s.service.sendSms('org-1', US, 'Hi Ana, thanks for reaching out to Skyline Realty!', { outreach: true });
      expect(sent.text).toBe('Hi Ana, thanks for reaching out to Skyline Realty!\nReply STOP to opt out.');
      expect(s.sentText()).toBe(sent.text);
      expect(s.prisma.message.count).toHaveBeenCalledWith({
        where: { orgId: 'org-1', direction: 'outbound', channel: 'sms', deliveryStatus: { not: 'failed' }, lead: { orgId: 'org-1', normalizedPhone: US } },
      });
    });

    it('leaves later texts to a US number alone', async () => {
      const s = setup({ earlierTexts: 2 });
      const sent = await s.service.sendSms('org-1', US, 'Hi Ana, just tried you.', { outreach: true });
      expect(sent.text).toBe('Hi Ana, just tried you.');
    });

    it('names the brokerage and our number on every text to a Canadian number', async () => {
      const s = setup({ earlierTexts: 5 });
      const sent = await s.service.sendSms('org-1', CA, 'Hi Ana, just tried you.', { outreach: true });
      expect(sent.text).toBe('Hi Ana, just tried you.\nSkyline Realty, (742) 724-5092. Reply STOP to opt out.');
    });
  });
});

describe('when Telnyx refuses a text (SMS08)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns its STOP block (40300) into an opt-out', async () => {
    const s = setup();
    s.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ code: '40300', title: 'Blocked due to STOP message' }] }), { status: 409 }),
    );
    await expect(s.service.sendSms('org-1', US, 'Hi')).rejects.toBeInstanceOf(OptedOutError);
  });

  it.each([
    ['a 503', 'Telnyx POST /messages failed 503: {}', true],
    ['a 429', 'Telnyx POST /messages failed 429: {}', true],
    ['a full sending queue', 'Telnyx POST /messages failed 400: {"errors":[{"code":"40318"}]}', true],
    ['a full sending queue, as telnyxErrorText words it', 'Telnyx POST /messages failed 400: Message queue full (40318)', true],
    ['no connection', 'Telnyx unreachable: fetch failed', true],
    ['a timeout', 'Telnyx unreachable: The operation was aborted due to timeout', false],
    ['an invalid number', 'Telnyx POST /messages failed 400: {"errors":[{"code":"40310"}]}', false],
    ['a refused key', 'Telnyx POST /messages failed 401: {}', false],
    ['no number configured', 'No from number configured', false],
  ])('after %s, tries again: %s', (_what, message, transient) => {
    expect(isTransientSmsError(new Error(message))).toBe(transient);
  });

  it('never tries again for an opted-out number', () => {
    expect(isTransientSmsError(new OptedOutError('This number asked not to be contacted'))).toBe(false);
  });
});

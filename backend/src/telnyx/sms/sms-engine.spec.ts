import { beforeEach, describe, expect, it, vi } from 'vitest';
import { telnyx } from '../telnyx-api';
import { SmsConversationService } from './sms-conversation.service';

vi.mock('../telnyx-api', () => ({ telnyx: vi.fn() }));

const CONFIG = { enabled: true, assistantId: 'assistant-1', messagingProfileId: 'profile-1', enabledAt: '2026-11-01T00:00:00Z' };

function setup(opts: { enabled?: boolean; engine?: string; sharedWith?: number; linkedTo?: string; failLink?: boolean; failSave?: boolean; held?: { normalizedPhone: string }[] } = {}) {
  let engine = opts.engine ?? 'telnyx';
  const calls: { path: string; method: string; body?: any }[] = [];
  vi.mocked(telnyx).mockReset();
  vi.mocked(telnyx).mockImplementation((async (_key: string, path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (method === 'PATCH' && path.startsWith('/messaging_profiles/') && opts.failLink && body?.ai_assistant_id) throw new Error('Telnyx PATCH failed 500');
    if (method === 'GET' && path.startsWith('/messaging_profiles/')) return { data: { ai_assistant_id: opts.linkedTo ?? '' } };
    if (method === 'GET' && path.startsWith('/ai/assistants/')) return { data: { instructions: '# Role', enabled_features: ['telephony'] } };
    if (method === 'GET' && path.startsWith('/ai/conversations?')) return { data: [{ id: 'conv-1' }] };
    return {};
  }) as any);
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => ({ smsConversation: opts.enabled === false ? null : CONFIG, inCallBooking: null, smsReplyEngine: engine })),
      count: vi.fn(async () => opts.sharedWith ?? 0),
      upsert: vi.fn(async ({ update }: any) => {
        if (opts.failSave && update.smsReplyEngine === 'estatepulse') throw new Error('db down');
        if (update.smsReplyEngine) engine = update.smsReplyEngine;
        return {};
      }),
    },
    lead: { findMany: vi.fn(async () => opts.held ?? []) },
  };
  const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1', messagingProfileId: 'profile-1', fromNumber: '+17427245092' })) };
  const config = { get: vi.fn(() => 'https://api.example') };
  const service = new SmsConversationService(prisma as any, creds as any, config as any, { ensure: vi.fn(async () => undefined) } as any);
  const links = () => calls.filter((c) => c.method === 'PATCH' && c.path === '/messaging_profiles/profile-1').map((c) => c.body.ai_assistant_id);
  return { service, prisma, calls, links, engine: () => engine };
}

describe('moving AI text replies between Telnyx and this server', () => {
  beforeEach(() => vi.clearAllMocks());

  it('to this server: unlinks the profile first, so Telnyx stops, then saves', async () => {
    const s = setup();
    const status = await s.service.setEngine('org-1', 'estatepulse');
    expect(s.links()).toEqual(['']);
    expect(status.engine).toBe('estatepulse');
    expect(await s.service.repliesHere('org-1')).toBe(true);
  });

  it('back to Telnyx: saves first, so this server stops, then links, and pauses held chats again', async () => {
    const s = setup({ engine: 'estatepulse', held: [{ normalizedPhone: '+12895550100' }, { normalizedPhone: '+12895550100' }, { normalizedPhone: '+15125550188' }] });
    await s.service.setEngine('org-1', 'telnyx');
    expect(s.links()).toEqual(['assistant-1']);
    expect(s.engine()).toBe('telnyx');
    const paused = s.calls.filter((c) => c.method === 'PUT' && c.path === '/ai/conversations/conv-1');
    expect(paused).toHaveLength(2);
    expect(paused[0].body).toEqual({ metadata: { ai_disabled: true } });
  });

  it('puts the link back when saving fails, so the AI keeps answering', async () => {
    const s = setup({ failSave: true });
    await expect(s.service.setEngine('org-1', 'estatepulse')).rejects.toThrow('db down');
    expect(s.links()).toEqual(['', 'assistant-1']);
  });

  it('goes back to this server when linking fails, so somebody still answers', async () => {
    const s = setup({ engine: 'estatepulse', failLink: true });
    await expect(s.service.setEngine('org-1', 'telnyx')).rejects.toThrow('500');
    expect(s.engine()).toBe('estatepulse');
  });

  it('refuses a profile another organization answers texts on', async () => {
    const s = setup({ sharedWith: 1 });
    await expect(s.service.setEngine('org-1', 'estatepulse')).rejects.toThrow('Another organization');
    expect(s.links()).toEqual([]);
    expect(s.engine()).toBe('telnyx');
  });

  it('only saves the choice while AI text replies are off, and changes nothing when it is already the one', async () => {
    const off = setup({ enabled: false });
    await off.service.setEngine('org-1', 'estatepulse');
    expect(off.links()).toEqual([]);
    expect(off.engine()).toBe('estatepulse');

    const same = setup();
    await same.service.setEngine('org-1', 'telnyx');
    expect(same.prisma.organizationSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('turning AI text replies on', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links the profile on Telnyx replies', async () => {
    const s = setup({ enabled: false });
    await s.service.enable('org-1');
    expect(s.links()).toEqual(['assistant-1']);
  });

  it("leaves the profile unlinked on this server's replies", async () => {
    const s = setup({ enabled: false, engine: 'estatepulse' });
    await s.service.enable('org-1');
    expect(s.links()).toEqual([]);
  });

  it("refuses a profile another organization's assistant already answers on", async () => {
    const s = setup({ enabled: false, linkedTo: 'assistant-other' });
    await expect(s.service.enable('org-1')).rejects.toThrow('another AI assistant');
    expect(s.links()).toEqual([]);
  });
});

describe("on this server's replies there is no Telnyx chat to keep", () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds nothing to a Telnyx chat and pauses none', async () => {
    const s = setup({ engine: 'estatepulse' });
    await s.service.appendToChat('org-1', '+12895550100', 'user', 'hi');
    expect(await s.service.pauseAi('org-1', '+12895550100', true)).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

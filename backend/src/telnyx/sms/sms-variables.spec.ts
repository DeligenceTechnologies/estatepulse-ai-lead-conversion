import { beforeEach, describe, expect, it, vi } from 'vitest';
import { telnyx } from '../telnyx-api';
import { SmsConversationService } from './sms-conversation.service';

vi.mock('../telnyx-api', () => ({ telnyx: vi.fn() }));

/** A text chat asks this server for the lead's details; when the server's address changes, the assistant follows it. */
describe('the text chat variables webhook', () => {
  const make = (current: string) => {
    vi.mocked(telnyx).mockImplementation((async (_key: string, _path: string, init?: { method?: string }) =>
      init?.method === 'PATCH' ? {} : { data: { dynamic_variables_webhook_url: current } }) as any);
    const prisma = { organizationSetting: { findMany: vi.fn(async () => [{ orgId: 'org-1' }]) } };
    const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })) };
    const config = { get: vi.fn(() => 'https://api.new-host.example') };
    return new SmsConversationService(prisma as any, creds as any, config as any);
  };
  const patches = () => vi.mocked(telnyx).mock.calls.filter(([, , init]) => (init as any)?.method === 'PATCH');

  beforeEach(() => vi.mocked(telnyx).mockReset());

  it('moves our webhook from an old address to this one', async () => {
    await make('https://old-tunnel.trycloudflare.com/webhooks/telnyx/assistant-variables').refreshVariablesUrls();
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(String((patches()[0][2] as any).body))).toEqual({
      dynamic_variables_webhook_url: 'https://api.new-host.example/webhooks/telnyx/assistant-variables',
    });
  });

  it('leaves it when it is already current, or an address the organization set itself', async () => {
    await make('https://api.new-host.example/webhooks/telnyx/assistant-variables').refreshVariablesUrls();
    await make('https://crm.example.com/lead-details').refreshVariablesUrls();
    expect(patches()).toHaveLength(0);
  });
});

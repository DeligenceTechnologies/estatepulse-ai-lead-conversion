import { beforeEach, describe, expect, it, vi } from 'vitest';
import { telnyx } from '../telnyx-api';
import { SmsConversationService } from './sms-conversation.service';
import { SMS_PROMPT_START, smsSection, withSmsSection } from './sms-prompt';

vi.mock('../telnyx-api', () => ({ telnyx: vi.fn() }));

/** At boot every chatting assistant is brought up to date: the variables webhook, the chat prompt and the call tools. */
describe('refreshing text chats', () => {
  const callTools = { ensure: vi.fn(async () => undefined) };
  const make = (current: string, instructions: unknown = withSmsSection('# Role')) => {
    vi.mocked(telnyx).mockImplementation((async (_key: string, _path: string, init?: { method?: string }) =>
      init?.method === 'PATCH' ? {} : { data: { dynamic_variables_webhook_url: current, instructions } }) as any);
    const prisma = { organizationSetting: { findMany: vi.fn(async () => [{ orgId: 'org-1' }]) } };
    const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })) };
    const config = { get: vi.fn(() => 'https://api.new-host.example') };
    return new SmsConversationService(prisma as any, creds as any, config as any, callTools as any);
  };
  const patches = () => vi.mocked(telnyx).mock.calls.filter(([, , init]) => (init as any)?.method === 'PATCH');
  const body = (i: number) => JSON.parse(String((patches()[i][2] as any).body));

  beforeEach(() => {
    vi.mocked(telnyx).mockReset();
    callTools.ensure.mockClear();
  });

  it('moves our webhook from an old address to this one', async () => {
    await make('https://old-tunnel.trycloudflare.com/webhooks/telnyx/assistant-variables').refreshChats();
    expect(patches()).toHaveLength(1);
    expect(body(0)).toEqual({ dynamic_variables_webhook_url: 'https://api.new-host.example/webhooks/telnyx/assistant-variables' });
  });

  it('leaves it when it is already current, or an address the organization set itself', async () => {
    await make('https://api.new-host.example/webhooks/telnyx/assistant-variables').refreshChats();
    await make('https://crm.example.com/lead-details').refreshChats();
    expect(patches()).toHaveLength(0);
  });

  it('rewrites an older chat section in place, keeping what comes after it', async () => {
    const old = `# Role\n\n${SMS_PROMPT_START}\n# Text conversations\n- an older rule\n[End of EstatePulse text conversations]\n\n# Booking`;
    await make('https://crm.example.com/lead-details', old).refreshChats();
    expect(patches()).toHaveLength(1);
    expect(body(0)).toEqual({ instructions: `# Role\n\n${smsSection()}\n\n# Booking` });
  });

  it('never writes over a prompt it could not read, and still puts the call tools on', async () => {
    await make('https://crm.example.com/lead-details', undefined).refreshChats();
    expect(patches()).toHaveLength(0);
    expect(callTools.ensure).toHaveBeenCalledWith('org-1');
  });
});

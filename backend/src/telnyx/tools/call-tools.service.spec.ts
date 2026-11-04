import { describe, expect, it, vi } from 'vitest';
import { telnyx } from '../telnyx-api';
import { CALL_TOOLS_VERSION } from './call-tools';
import { CallToolsService } from './call-tools.service';

vi.mock('../telnyx-api', () => ({ telnyx: vi.fn() }));

describe('CallToolsService', () => {
  it("keeps the organization's retry and text-back settings when it provisions the tools", async () => {
    let stored: Record<string, unknown> = { retryMinutes: 60, retryAttempts: 0, textBack: false, textBackMessage: 'Custom text' };
    const prisma = {
      organizationSetting: {
        findUnique: vi.fn(async () => ({ callTools: stored })),
        upsert: vi.fn(async ({ update }: any) => {
          stored = update.callTools;
        }),
      },
    };
    const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })) };
    const config = { get: vi.fn(() => 'https://api.example.com') };
    vi.mocked(telnyx).mockImplementation((async (_key: string, path: string, init?: { method?: string }) => {
      if (path === '/integration_secrets') return { data: { id: 'secret-1' } };
      if (path === '/ai/tools') return { data: { id: 'tool-1' } };
      if (path === '/ai/assistants/assistant-1' && !init?.method) return { data: { instructions: '# Role' } };
      return {};
    }) as any);

    await new CallToolsService(prisma as any, creds as any, config as any).ensure('org-1');

    expect(stored).toMatchObject({
      enabled: true,
      retryMinutes: 60,
      retryAttempts: 0,
      textBack: false,
      textBackMessage: 'Custom text',
      telnyx: expect.objectContaining({ assistantId: 'assistant-1', version: CALL_TOOLS_VERSION, toolIds: ['tool-1', 'tool-1', 'tool-1'] }),
    });
  });

  it('takes our tools off the assistant when nothing records them, so a name clash never blocks putting them on again', async () => {
    let stored: Record<string, unknown> = { enabled: true, telnyx: null };
    const prisma = {
      organizationSetting: {
        findUnique: vi.fn(async () => ({ callTools: stored })),
        upsert: vi.fn(async ({ update }: any) => {
          stored = update.callTools;
        }),
      },
    };
    const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })) };
    const config = { get: vi.fn(() => 'https://api.example.com') };
    const calls: string[] = [];
    vi.mocked(telnyx).mockReset();
    vi.mocked(telnyx).mockImplementation((async (_key: string, path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/integration_secrets') return { data: { id: 'secret-1' } };
      if (path === '/ai/tools') return { data: { id: 'tool-new' } };
      if (path === '/ai/assistants/assistant-1' && !init?.method) {
        return {
          data: {
            instructions: '# Role',
            tools: [
              { type: 'hangup', tool_id: 'tool-hangup' },
              { type: 'webhook', tool_id: 'tool-stray', webhook: { name: 'schedule_callback' } },
              { type: 'webhook', tool_id: 'tool-booking', webhook: { name: 'check_availability' } },
            ],
          },
        };
      }
      return {};
    }) as any);

    await new CallToolsService(prisma as any, creds as any, config as any).ensure('org-1');

    expect(calls).toContain('DELETE /ai/assistants/assistant-1/tools/tool-stray');
    expect(calls).toContain('DELETE /ai/tools/tool-stray');
    expect(calls.filter((c) => c.startsWith('DELETE') && (c.includes('tool-hangup') || c.includes('tool-booking')))).toEqual([]);
    expect(stored).toMatchObject({ telnyx: expect.objectContaining({ toolIds: ['tool-new', 'tool-new', 'tool-new'] }) });
  });
});

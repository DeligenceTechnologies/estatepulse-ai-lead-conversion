import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AssistantConfig } from './assistant.config';

const config = (env: Record<string, unknown>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('assistant config', () => {
  it('reads the tools to switch off from a comma-separated list, ignoring spaces and blanks', () => {
    const c = AssistantConfig.fromConfigService(config({ ASSISTANT_DISABLED_TOOLS: ' text_send, meeting_book ,,' }));
    expect([...c.disabledTools]).toEqual(['text_send', 'meeting_book']);
  });

  it('switches nothing off when the setting is empty or missing', () => {
    expect(AssistantConfig.fromConfigService(config({ ASSISTANT_DISABLED_TOOLS: '' })).disabledTools.size).toBe(0);
    expect(AssistantConfig.fromConfigService(config({})).disabledTools.size).toBe(0);
  });
});

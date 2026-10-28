import { describe, expect, it } from 'vitest';
import { fillTemplate } from '../template';
import {
  CALL_TOOLS_PROMPT_END,
  CALL_TOOLS_PROMPT_START,
  DEFAULT_CONFIRM_MESSAGE,
  callToolDefinitions,
  callToolsSettings,
  withCallToolsSection,
  withoutCallToolsSection,
} from './call-tools';

describe('call tools', () => {
  it('are on by default, with the confirmation SMS, its default text and one retry 15 minutes after a miss', () => {
    expect(callToolsSettings(null)).toEqual({
      enabled: true,
      confirmSms: true,
      confirmMessage: DEFAULT_CONFIRM_MESSAGE,
      retryMinutes: 15,
      retryAttempts: 1,
      telnyx: null,
    });
    expect(callToolsSettings({ enabled: false, confirmSms: false, confirmMessage: '  Hi  ' })).toMatchObject({ enabled: false, confirmSms: false, confirmMessage: 'Hi' });
  });

  it("keep the organization's retry when it is in range, else the default", () => {
    expect(callToolsSettings({ retryMinutes: 60, retryAttempts: 0 })).toMatchObject({ retryMinutes: 60, retryAttempts: 0 });
    expect(callToolsSettings({ retryMinutes: 1, retryAttempts: 9 })).toMatchObject({ retryMinutes: 15, retryAttempts: 1 });
  });

  it('add their prompt section once, and remove only it', () => {
    const own = '# Role\nYou are a warm assistant.';
    const once = withCallToolsSection(own);
    expect(withCallToolsSection(once)).toBe(once);
    expect(once.indexOf(CALL_TOOLS_PROMPT_START)).toBeGreaterThan(own.length);
    expect(once.endsWith(CALL_TOOLS_PROMPT_END)).toBe(true);
    expect(withoutCallToolsSection(once)).toBe(own);
  });

  it('identify the call or chat by Telnyx presets, never by the model', () => {
    const [callback, outcome] = callToolDefinitions('https://api.example.com', 'ep_calltools_x');
    expect(callback.webhook.url).toBe('https://api.example.com/tools/telnyx/outcome/callback');
    expect(outcome.webhook.url).toBe('https://api.example.com/tools/telnyx/outcome/record');
    for (const tool of [callback, outcome]) {
      expect(tool.webhook.preset_body_fields).toEqual({ lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}', end_user: '{{telnyx_end_user_target}}' });
      expect(Object.keys(tool.webhook.body_parameters.properties)).not.toContain('lead_id');
      expect(tool.webhook.headers[0].value).toContain('ep_calltools_x');
    }
    expect(outcome.webhook.body_parameters.properties.outcome?.enum).toEqual(['not_interested', 'do_not_contact', 'wrong_number']);
  });

  it('fill a message template, dropping a placeholder with no value', () => {
    expect(fillTemplate(DEFAULT_CONFIRM_MESSAGE, { firstName: 'Ana', callbackTime: 'Wednesday, October 28 at 5:00 PM' })).toBe(
      "Thanks Ana! I'll call you back on Wednesday, October 28 at 5:00 PM. If another time suits you better, just reply here.",
    );
    expect(fillTemplate('Hi {{firstName}}, this is {{brokerage}}.', { firstName: 'Ana' })).toBe('Hi Ana, this is.');
  });
});

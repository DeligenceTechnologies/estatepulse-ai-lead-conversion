import { describe, expect, it } from 'vitest';
import { fillTemplate } from '../template';
import {
  CALL_TOOLS_PROMPT_END,
  CALL_TOOLS_PROMPT_START,
  DEFAULT_CONFIRM_MESSAGE,
  DEFAULT_TEXT_BACK_MESSAGE,
  callToolDefinitions,
  callToolsSection,
  callToolsSettings,
  withCallToolsSection,
  withoutCallToolsSection,
} from './call-tools';

describe('call tools', () => {
  it('are on by default, with the confirmation SMS, one retry 15 minutes after a miss and texting the lead back', () => {
    expect(callToolsSettings(null)).toEqual({
      enabled: true,
      confirmSms: true,
      confirmMessage: DEFAULT_CONFIRM_MESSAGE,
      retryMinutes: 15,
      retryAttempts: 1,
      textBack: true,
      textBackMessage: DEFAULT_TEXT_BACK_MESSAGE,
      telnyx: null,
    });
    expect(callToolsSettings({ textBack: false, textBackMessage: ' Hey {{firstName}} ' })).toMatchObject({ textBack: false, textBackMessage: 'Hey {{firstName}}' });
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
    const [callback, text, outcome, meeting] = callToolDefinitions('https://api.example.com', 'ep_calltools_x');
    expect(callback.webhook.url).toBe('https://api.example.com/tools/telnyx/outcome/callback');
    expect(text.webhook.url).toBe('https://api.example.com/tools/telnyx/outcome/text');
    expect(text.webhook.name).toBe('schedule_text');
    expect(outcome.webhook.url).toBe('https://api.example.com/tools/telnyx/outcome/record');
    expect(meeting.webhook.name).toBe('get_meeting');
    expect(meeting.webhook.url).toBe('https://api.example.com/tools/telnyx/outcome/meeting');
    for (const tool of [callback, text, outcome, meeting]) {
      expect(tool.webhook.preset_body_fields).toEqual({ lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}', end_user: '{{telnyx_end_user_target}}' });
      expect(Object.keys(tool.webhook.body_parameters.properties)).not.toContain('lead_id');
      expect(tool.webhook.headers[0].value).toContain('ep_calltools_x');
    }
    expect(outcome.webhook.body_parameters.properties.outcome?.enum).toEqual(['not_interested', 'do_not_contact', 'wrong_number']);
  });

  it('tell the AI a text later is schedule_text and a call later is schedule_callback', () => {
    const section = callToolsSection();
    expect(section).toContain('call schedule_text');
    expect(section).toContain('Never promise a text without it');
    expect(section).toContain('Never promise a callback without it');
  });

  it('send a lead who wants to move or cancel a meeting to get_meeting, never to a second booking', () => {
    const section = callToolsSection();
    expect(section).toContain('call get_meeting first');
    expect(section).toContain('Never book a second meeting');
  });

  it('fill a message template, dropping a placeholder with no value', () => {
    expect(fillTemplate(DEFAULT_CONFIRM_MESSAGE, { firstName: 'Ana', callbackTime: 'Wednesday, October 28 at 5:00 PM' })).toBe(
      "Thanks Ana! I'll call you back on Wednesday, October 28 at 5:00 PM. If another time suits you better, just reply here.",
    );
    expect(fillTemplate('Hi {{firstName}}, this is {{brokerage}}.', { firstName: 'Ana' })).toBe('Hi Ana, this is.');
  });
});

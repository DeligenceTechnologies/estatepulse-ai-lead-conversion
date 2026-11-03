import { describe, expect, it } from 'vitest';
import { DEFAULT_GREETING, legacyDefaultsReplaced, withoutRecordingNotice } from './assistant.service';
import { fillTemplate } from './template';
import { CALLBACK_GREETING } from './tools/call-tools';

const OLD_GREETING = 'Hi, this is your home-buying assistant, calling about your recent enquiry. Are you looking to buy a home sometime soon?';
const OLD_ROLE =
  '# Role\nYou are a warm, professional AI assistant for a real estate brokerage. You are calling a home-buyer lead who recently enquired, to qualify them over the phone. You placed this call, so never thank them for calling in.';
const NOTICE = 'Just so you know, this call is recorded for quality and training.';

/** A lead hears who is calling, and that it is an AI, before anything else. */
describe('greetings name the brokerage and disclose the AI', () => {
  it('the first call and the callback both say so', () => {
    for (const g of [DEFAULT_GREETING, CALLBACK_GREETING]) {
      expect(fillTemplate(g, { firstName: 'Sam', brokerage: 'Maple Realty' })).toMatch(/^Hi Sam, .*AI assistant .*Maple Realty/);
    }
  });

  it('moves an unedited old greeting and role onto the new ones, keeping later sections', () => {
    const patch = legacyDefaultsReplaced({ greeting: `${NOTICE} ${OLD_GREETING}`, instructions: `${OLD_ROLE}\n\n# Goal\nx\n\n# Booking\ny` });
    expect(patch?.greeting).toBe(DEFAULT_GREETING);
    expect(patch?.instructions).toMatch(/^# Role\n.*on behalf of \{\{brokerage\}\}.*never claim or imply to be a person/);
    expect(patch?.instructions).toContain('\n\n# Goal\nx\n\n# Booking\ny');
    expect(legacyDefaultsReplaced({ greeting: OLD_GREETING })).toEqual({ greeting: DEFAULT_GREETING });
  });

  it('takes a saved recording notice out of any greeting: the call plays it, before recording', () => {
    expect(legacyDefaultsReplaced({ greeting: `${NOTICE} Hello from Maple Realty!` })).toEqual({ greeting: 'Hello from Maple Realty!' });
    expect(withoutRecordingNotice(`${NOTICE} ${NOTICE}  Hi there`)).toBe('Hi there');
    expect(withoutRecordingNotice('Hi there')).toBe('Hi there');
  });

  it('leaves a greeting or role the organization wrote alone', () => {
    expect(legacyDefaultsReplaced({ greeting: 'Hello from Maple Realty!', instructions: '# Role\nCustom.' })).toBeNull();
    expect(legacyDefaultsReplaced({ greeting: DEFAULT_GREETING })).toBeNull();
  });
});

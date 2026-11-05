import { describe, expect, it } from 'vitest';
import { displayNumber, previewTemplate, smsSize, withOutreachFooter } from './smsCompliance';

const base = { brokerage: 'Skyline Realty', ourNumber: '+17427245092' };

// The same cases as backend/src/telnyx/sms/sms-compliance.spec.ts: the preview must show what the server sends.
describe('withOutreachFooter', () => {
  it('adds the brand and the STOP line to a first text that has neither', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana, are you still looking?', canadian: false, firstText: true })).toBe(
      'Hi Ana, are you still looking?\nSkyline Realty: Reply STOP to opt out.',
    );
  });

  it('adds only the STOP line when the text names the brokerage', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana, this is SKYLINE REALTY.', canadian: false, firstText: true })).toBe(
      'Hi Ana, this is SKYLINE REALTY.\nReply STOP to opt out.',
    );
  });

  it('adds only the brand to a first text that already says how to stop', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana! Text STOP to opt out.', canadian: false, firstText: true })).toBe(
      'Hi Ana! Text STOP to opt out.\nSkyline Realty.',
    );
  });

  it('leaves a later text to a US number alone, and names us on every Canadian one', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana', canadian: false, firstText: false })).toBe('Hi Ana');
    expect(withOutreachFooter({ ...base, text: 'Hi Ana', canadian: true, firstText: false })).toBe('Hi Ana\nSkyline Realty, (742) 724-5092. Reply STOP to opt out.');
  });
});

describe('displayNumber', () => {
  it('writes a North American number as people do, and leaves others alone', () => {
    expect(displayNumber('+17427245092')).toBe('(742) 724-5092');
    expect(displayNumber('+918447329358')).toBe('+918447329358');
  });
});

describe('previewTemplate', () => {
  it('fills the sample lead and the brokerage, spaced as the server does', () => {
    expect(previewTemplate('Hi {{firstName}} , thanks for reaching out to {{ brokerage }}!', 'Skyline Realty')).toBe('Hi Ana, thanks for reaching out to Skyline Realty!');
  });
});

describe('smsSize', () => {
  it('counts 160 GSM-7 characters as one text and 153 a text beyond', () => {
    expect(smsSize('a'.repeat(160))).toEqual({ encoding: 'GSM-7', segments: 1, culprit: null });
    expect(smsSize('a'.repeat(161)).segments).toBe(2);
    expect(smsSize('a'.repeat(306)).segments).toBe(2);
    expect(smsSize('a'.repeat(307)).segments).toBe(3);
  });

  it('counts an extended character as two', () => {
    expect(smsSize('€'.repeat(80)).segments).toBe(1);
    expect(smsSize('€'.repeat(81)).segments).toBe(2);
  });

  it('switches to UCS-2 for an em dash, a curly quote or an emoji, and names it', () => {
    expect(smsSize('Hi — there')).toEqual({ encoding: 'UCS-2', segments: 1, culprit: '—' });
    expect(smsSize('I’ll call').culprit).toBe('’');
    expect(smsSize('x'.repeat(71) + '🙂').segments).toBe(2);
  });

  it('counts the default first text with its footer as two texts', () => {
    const text = previewTemplate(
      "Hi {{firstName}}, thanks for reaching out to {{brokerage}}! Are you looking to buy in the next few months? Reply anytime, or I'll give you a quick call.",
      'Skyline Realty',
    );
    expect(smsSize(withOutreachFooter({ ...base, text, canadian: false, firstText: true }))).toEqual({ encoding: 'GSM-7', segments: 2, culprit: null });
  });
});

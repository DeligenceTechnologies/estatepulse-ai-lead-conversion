import { describe, expect, it } from 'vitest';
import { smsSegments } from './sms-segments';

describe('smsSegments', () => {
  it('an empty text is still one segment', () => {
    expect(smsSegments('')).toBe(1);
  });

  it('GSM text: 160 fit in one, 161 take two of 153', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
  });

  it('GSM extension characters count twice', () => {
    expect(smsSegments('€'.repeat(80))).toBe(1);
    expect(smsSegments('€'.repeat(81))).toBe(2);
  });

  it('one character outside GSM makes it UCS-2: 70 in one, 71 take two of 67', () => {
    expect(smsSegments('“' + 'a'.repeat(69))).toBe(1);
    expect(smsSegments('“' + 'a'.repeat(70))).toBe(2);
  });

  it('an emoji is two UTF-16 units', () => {
    expect(smsSegments('😀'.repeat(35))).toBe(1);
    expect(smsSegments('😀'.repeat(36))).toBe(2);
  });
});

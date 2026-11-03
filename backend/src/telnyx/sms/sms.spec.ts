import { describe, expect, it } from 'vitest';
import { withBookingSection } from '@/calendar/booking/booking-prompt';
import { parseIntent } from './sms-intent.service';
import { SMS_PROMPT_START, withSmsSection, withoutSmsSection } from './sms-prompt';

describe('parseIntent', () => {
  it('reads the model answer', () => {
    expect(parseIntent('{"intent":"not_interested","reason":"already bought"}')).toEqual({ intent: 'not_interested', reason: 'already bought' });
  });

  it('gives nothing for an unusable answer, which may have been an opt-out, rather than reading it as "continue"', () => {
    expect(parseIntent('not json')).toBeNull();
    expect(parseIntent({ intent: 'hang_up', reason: 'x' })).toBeNull();
    expect(parseIntent(undefined)).toBeNull();
  });
});

describe('text-chat prompt section', () => {
  const own = '# Role\nYou qualify home buyers.';

  it('is added once, and taken out again without touching the org prompt', () => {
    const once = withSmsSection(own);
    expect(withSmsSection(once)).toBe(once);
    expect(once.split(SMS_PROMPT_START)).toHaveLength(2);
    expect(withoutSmsSection(once)).toBe(own);
  });

  it('keeps the booking section when either is added or removed', () => {
    const both = withSmsSection(withBookingSection(own, '30 min consult', 30));
    expect(both).toContain('# Booking an appointment');
    expect(withoutSmsSection(both)).toBe(withBookingSection(own, '30 min consult', 30));
  });
});

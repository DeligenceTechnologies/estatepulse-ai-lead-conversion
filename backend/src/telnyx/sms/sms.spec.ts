import { describe, expect, it } from 'vitest';
import { withBookingSection } from '@/calendar/booking/booking-prompt';
import { parseIntent } from './sms-intent.service';
import { SMS_PROMPT_START, withSmsSection, withoutSmsSection } from './sms-prompt';

describe('parseIntent', () => {
  it('reads the model answer', () => {
    expect(parseIntent('{"intent":"not_interested","reason":"already bought"}')).toEqual({ intent: 'not_interested', reason: 'already bought' });
  });

  it('never ends a conversation on an unusable answer', () => {
    expect(parseIntent('not json').intent).toBe('continue');
    expect(parseIntent({ intent: 'hang_up', reason: 'x' }).intent).toBe('continue');
    expect(parseIntent(undefined).intent).toBe('continue');
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

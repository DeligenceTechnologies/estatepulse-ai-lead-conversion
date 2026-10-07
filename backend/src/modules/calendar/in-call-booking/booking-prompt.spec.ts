import { describe, expect, it } from 'vitest';
import { BOOKING_PROMPT_END, BOOKING_PROMPT_START, withBookingSection, withoutBookingSection } from './booking-prompt';

const OFFICE = '# Role\nYou are the assistant for Austin Homes.\n\n# Goal\nQualify buyers.';

describe('booking prompt section', () => {
  it('appends one section after the office prompt, naming the event type', () => {
    const p = withBookingSection(OFFICE, 'Buyer consultation', 30);
    expect(p.startsWith(OFFICE + '\n\n' + BOOKING_PROMPT_START)).toBe(true);
    expect(p.endsWith(BOOKING_PROMPT_END)).toBe(true);
    expect(p).toContain('30-minute "Buyer consultation"');
    expect(p).toContain('check_availability');
    expect(p).toContain('book_appointment');
  });

  it('replaces rather than duplicates on a second enable (e.g. switching event type)', () => {
    const once = withBookingSection(OFFICE, 'Buyer consultation', 30);
    const twice = withBookingSection(once, 'Showing', 45);
    expect(twice.split(BOOKING_PROMPT_START)).toHaveLength(2);
    expect(twice).toContain('45-minute "Showing"');
    expect(twice).not.toContain('Buyer consultation');
  });

  it('removes exactly the section, leaving the office prompt byte for byte', () => {
    expect(withoutBookingSection(withBookingSection(OFFICE, 'X', 30))).toBe(OFFICE);
  });

  it('keeps office text the owner added after the section', () => {
    const edited = withBookingSection(OFFICE, 'X', 30) + '\n# Closing\nBe brief.';
    expect(withoutBookingSection(edited)).toBe(OFFICE + '\n# Closing\nBe brief.');
  });

  it('works on an empty prompt, and leaves a prompt without the section alone', () => {
    expect(withBookingSection('', 'X', 30).startsWith(BOOKING_PROMPT_START)).toBe(true);
    expect(withoutBookingSection(OFFICE)).toBe(OFFICE);
  });
});

/**
 * The booking section of the office's AI prompt.
 *
 * Offices write their own prompt on the AI Prompt & Tone page, so the booking
 * guidance cannot live in it by assumption. Turning in-call booking on appends
 * this section between two marker lines; turning it off removes exactly that
 * span. Everything the office wrote outside the markers is left byte for byte.
 *
 * Pure; tested in booking-prompt.spec.ts.
 */

export const BOOKING_PROMPT_START = '[EstatePulse: appointment booking — added by In-call booking in AI Settings; turn it off there to remove]';
export const BOOKING_PROMPT_END = '[End of EstatePulse appointment booking]';

export function bookingSection(eventTypeName: string, durationMinutes: number): string {
  return [
    BOOKING_PROMPT_START,
    '# Booking an appointment',
    `When the caller wants to meet, talk to or see a property with one of our agents, offer to book a ${durationMinutes}-minute "${eventTypeName}" for them during this call.`,
    '1. Ask which day suits them, and a time if they have one in mind.',
    '2. Call check_availability with that day (YYYY-MM-DD, "today", "tomorrow" or a weekday name) and, if they named one, preferred_time in 24-hour HH:MM.',
    '3. Offer two or three of the returned slots, reading each one\'s "spoken" text exactly. Never suggest a time the tool did not return. If their time is not available, say so and offer the returned ones.',
    '4. When they choose, call book_appointment with that slot\'s exact "start" value.',
    '5. If the result is email_required, ask for their email, spell it back letter by letter to confirm, then call book_appointment again with email.',
    '6. If the result is slot_taken, apologise and offer the new slots returned.',
    '7. Once booked, confirm the day, time and agent\'s name, and tell them a calendar invite is on its way by email.',
    'An agent is assigned automatically when the meeting is booked; never promise a specific agent beforehand. If booking fails, say an agent will call them to arrange a time.',
    BOOKING_PROMPT_END,
  ].join('\n');
}

/** The prompt without our section (and the blank line we added before it). */
export function withoutBookingSection(instructions: string): string {
  const start = instructions.indexOf(BOOKING_PROMPT_START);
  if (start < 0) return instructions;
  const endAt = instructions.indexOf(BOOKING_PROMPT_END, start);
  const end = endAt < 0 ? instructions.length : endAt + BOOKING_PROMPT_END.length;
  const before = instructions.slice(0, start).replace(/\n{1,2}$/, '');
  const after = instructions.slice(end).replace(/^\n/, '');
  return after ? `${before}\n${after}` : before;
}

/** The prompt with exactly one, current booking section at the end. */
export function withBookingSection(instructions: string, eventTypeName: string, durationMinutes: number): string {
  const base = withoutBookingSection(instructions ?? '').replace(/\s+$/, '');
  const section = bookingSection(eventTypeName, durationMinutes);
  return base ? `${base}\n\n${section}` : section;
}

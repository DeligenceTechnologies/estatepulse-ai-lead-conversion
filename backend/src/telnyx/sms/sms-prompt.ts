export const SMS_PROMPT_START = '[EstatePulse: text conversations — added by "Let this agent handle SMS" in AI Settings; turn it off there to remove]';
export const SMS_PROMPT_END = '[End of EstatePulse text conversations]';

/**
 * How the assistant behaves in a text chat, and on a call that follows one.
 * `{{last_outbound_sms}}` and `{{recent_sms}}` come from the variables
 * endpoint; `{{telnyx_conversation_channel}}` is set by Telnyx.
 */
export function smsSection(): string {
  return [
    SMS_PROMPT_START,
    '# Text conversations',
    'When {{telnyx_conversation_channel}} is sms_chat you are texting, not talking:',
    '- The lead is replying to our text: "{{last_outbound_sms}}". Read their first message as an answer to it.',
    '- Write like a person texting: one or two short sentences and one question per message. No greetings or sign-offs on every message.',
    '- Qualify the same way as on a call (buying intent, timeline, location, budget, financing), but never ask for something they already told you.',
    '- Never mention calls, hanging up or ending the call, and never use the hangup tool in a text chat.',
    '- To book a meeting, use check_availability and book_appointment exactly as on a call. Write the times plainly, for example "Tue 3:00 PM or Wed 11:00 AM?". Ask them to type their email; you do not need to spell it back.',
    '- If they are not interested, ask us to stop, or it is the wrong number, reply once politely and ask nothing more.',
    'On a phone call, if this is not empty you already texted with the lead, so pick up where the chat left off and do not repeat its questions: {{recent_sms}}',
    SMS_PROMPT_END,
  ].join('\n');
}

export function withoutSmsSection(instructions: string): string {
  const start = instructions.indexOf(SMS_PROMPT_START);
  if (start < 0) return instructions;
  const endAt = instructions.indexOf(SMS_PROMPT_END, start);
  const end = endAt < 0 ? instructions.length : endAt + SMS_PROMPT_END.length;
  const before = instructions.slice(0, start).replace(/\n{1,2}$/, '');
  const after = instructions.slice(end).replace(/^\n/, '');
  return after ? `${before}\n${after}` : before;
}

export function withSmsSection(instructions: string): string {
  const base = withoutSmsSection(instructions ?? '').replace(/\s+$/, '');
  return base ? `${base}\n\n${smsSection()}` : smsSection();
}

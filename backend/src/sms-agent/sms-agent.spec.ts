import { describe, expect, it } from 'vitest';
import { REPLY_MAX_CHARS, chatHistory, fillVariables, guardReply, personReason, toolFunctions } from './sms-agent';

const lead = (status: string, extra: Partial<{ dncStatus: boolean; takenOverById: string | null }> = {}) =>
  ({ status, dncStatus: false, takenOverById: null, ...extra }) as Parameters<typeof personReason>[0];

describe('personReason', () => {
  it.each(['new', 'contacting', 'engaged', 'follow_up', 'unresponsive', 'interested', 'appointment_requested'])('lets the AI answer a lead that is %s', (status) => {
    expect(personReason(lead(status))).toBeNull();
  });

  it.each([
    ['appointment_booked', 'the lead is appointment booked'],
    ['closed', 'the lead is closed'],
    ['not_interested', 'the lead is not interested'],
    ['invalid', 'the lead is invalid'],
  ])('leaves a lead that is %s to a person', (status, why) => {
    expect(personReason(lead(status))).toBe(why);
  });

  it('leaves a chat an agent holds, and an opted-out lead, to a person whatever the status', () => {
    expect(personReason(lead('engaged', { takenOverById: 'agent-1' }))).toBe('an agent has taken the chat over');
    expect(personReason(lead('engaged', { dncStatus: true }))).toBe('the lead opted out');
  });
});

describe('fillVariables', () => {
  it('fills what it knows, leaves the rest empty, and keeps line breaks', () => {
    expect(fillVariables('# Role\nHi {{ firstName }} from {{brokerage}}.\n{{unknown}}End', { firstName: 'Ana', brokerage: 'Skyline' })).toBe(
      '# Role\nHi Ana from Skyline.\nEnd',
    );
  });
});

describe('chatHistory', () => {
  it("reads the lead's texts as user turns and ours as assistant turns, marking an agent's", () => {
    expect(
      chatHistory([
        { direction: 'outbound', senderType: 'ai', body: 'Hi Ana!' },
        { direction: 'inbound', senderType: 'lead', body: 'Hi' },
        { direction: 'outbound', senderType: 'user', body: 'Priya here.', senderUser: { firstName: 'Priya', lastName: 'S', email: 'p@x.com' } },
        { direction: 'inbound', senderType: 'lead', body: '   ' },
      ]),
    ).toEqual([
      { role: 'assistant', content: 'Hi Ana!' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '[Agent Priya S] Priya here.' },
    ]);
  });
});

describe('toolFunctions', () => {
  const hook = (name: string, extra: Record<string, unknown> = {}) => ({
    type: 'webhook',
    webhook: { name, description: `${name} does it`, body_parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra },
  });

  it("offers the assistant's own tools this server runs, with their descriptions and parameters", () => {
    const tools = toolFunctions([hook('schedule_callback'), hook('book_appointment'), { type: 'hangup', hangup: {} }, hook('crm_lookup'), hook('schedule_callback')]);
    expect(tools.map((t) => t.function.name)).toEqual(['schedule_callback', 'book_appointment']);
    expect(tools[0]).toEqual({
      type: 'function',
      function: { name: 'schedule_callback', description: 'schedule_callback does it', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
    });
  });

  it('gives an empty parameter list to a tool without one', () => {
    expect(toolFunctions([{ type: 'webhook', webhook: { name: 'record_outcome' } }])[0].function.parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('guardReply', () => {
  it('takes out a link nobody gave and keeps one a tool returned', () => {
    expect(guardReply('Book here: https://evil.example/x or bit.ly/abc', [])).toBe('Book here: or');
    expect(guardReply('Your meeting: https://calendly.com/m/123', ['https://calendly.com/m/123'])).toBe('Your meeting: https://calendly.com/m/123');
  });

  it('drops an "[Agent …]" prefix the model copied from the chat, and any thinking', () => {
    expect(guardReply('[Agent Priya] Sure, Saturday works.')).toBe('Sure, Saturday works.');
    expect(guardReply('<think>they want Saturday</think>Saturday works!')).toBe('Saturday works!');
  });

  it('keeps it to three texts, cut at a sentence', () => {
    const long = `${'This is a sentence. '.repeat(40)}`;
    const reply = guardReply(long);
    expect(reply.length).toBeLessThanOrEqual(REPLY_MAX_CHARS);
    expect(reply.endsWith('.')).toBe(true);
  });

  it('is empty when nothing is left to send', () => {
    expect(guardReply('   ')).toBe('');
    expect(guardReply('https://evil.example')).toBe('');
  });
});

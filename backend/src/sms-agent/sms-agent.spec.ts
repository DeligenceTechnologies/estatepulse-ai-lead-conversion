import { describe, expect, it } from 'vitest';
import { REPLY_MAX_CHARS, chatHistory, currentConversation, fillVariables, guardReply, replyRoute, standingNote, toolFunctions } from './sms-agent';

const lead = (status: string, extra: Partial<{ dncStatus: boolean; takenOverById: string | null; agentCanReply: boolean }> = {}) =>
  ({ status, dncStatus: false, takenOverById: null, agentCanReply: false, ...extra }) as Parameters<typeof replyRoute>[0];

describe('replyRoute', () => {
  it.each(['new', 'contacting', 'engaged', 'follow_up', 'unresponsive', 'interested', 'appointment_requested'])(
    'lets the AI answer a lead that is %s, agent or not',
    (status) => {
      expect(replyRoute(lead(status))).toEqual({ by: 'ai', flagOwner: false });
      expect(replyRoute(lead(status, { agentCanReply: true }))).toEqual({ by: 'ai', flagOwner: false });
    },
  );

  it.each(['appointment_booked', 'closed', 'not_interested', 'invalid'])('leaves a lead that is %s to its agent, unflagged, when it has one', (status) => {
    expect(replyRoute(lead(status, { agentCanReply: true }))).toEqual({ by: 'person', reason: `the lead is ${status.replace(/_/g, ' ')} and its agent answers`, flagOwner: false });
  });

  it.each(['closed', 'not_interested', 'invalid'])('lets the AI answer a lead that is %s when no agent can', (status) => {
    expect(replyRoute(lead(status))).toEqual({ by: 'ai', flagOwner: false });
  });

  it('lets the AI answer a booked lead with no agent, and flags the owner to follow up on the meeting', () => {
    expect(replyRoute(lead('appointment_booked'))).toEqual({ by: 'ai', flagOwner: true });
  });

  it('leaves a chat an agent holds to them, and texts an opted-out lead nothing, flagging the owner', () => {
    expect(replyRoute(lead('engaged', { takenOverById: 'agent-1' }))).toEqual({ by: 'person', reason: 'an agent has taken the chat over', flagOwner: false });
    expect(replyRoute(lead('engaged', { dncStatus: true }))).toEqual({ by: 'person', reason: 'the lead opted out', flagOwner: true });
  });
});

describe('standingNote', () => {
  it('tells the AI where a lead outside the usual chat stands, and nothing for an active one', () => {
    expect(standingNote('not_interested' as any, false)).toContain('not interested');
    expect(standingNote('invalid' as any, false)).toContain('wrong number');
    expect(standingNote('closed' as any, false)).toContain('closed');
    expect(standingNote('appointment_booked' as any, false)).toContain('Never book another');
    expect(standingNote('new' as any, true)).toContain('not one of our leads');
    expect(standingNote('engaged' as any, false)).toBe('');
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

  it("keeps an email whole: its domain is not a link", () => {
    expect(guardReply('A calendar invite is on its way to dee.four@example.com. See you then!')).toBe('A calendar invite is on its way to dee.four@example.com. See you then!');
    expect(guardReply('Write to ana@x.co or see bit.ly/abc')).toBe('Write to ana@x.co or see');
  });

  it('turns the typographic characters a model likes into GSM-7 ones, so a text stays 160 characters a part', () => {
    expect(guardReply('Got it \u2014 a 3-bed. You\u2019re \u201Cset\u201D\u2026')).toBe('Got it - a 3-bed. You\'re "set"...');
  });

  it('is empty when nothing is left to send', () => {
    expect(guardReply('   ')).toBe('');
    expect(guardReply('https://evil.example')).toBe('');
  });
});

describe('currentConversation', () => {
  const at = (iso: string, body: string) => ({ body, createdAt: new Date(iso) });

  it('keeps the texts since the last quiet spell of more than a day, oldest first', () => {
    const newestFirst = [
      at('2026-11-04T10:05:00Z', 'Budget 600k'),
      at('2026-11-04T10:00:00Z', 'What areas?'),
      at('2026-11-03T12:00:00Z', 'Hi Ana, thanks for reaching out!'),
      at('2026-10-30T07:28:00Z', 'Booked for Saturday'),
    ];
    expect(currentConversation(newestFirst).map((t) => t.body)).toEqual(['Hi Ana, thanks for reaching out!', 'What areas?', 'Budget 600k']);
  });

  it('keeps everything when there is no such gap, or no time to tell', () => {
    expect(currentConversation([at('2026-11-04T10:00:00Z', 'b'), at('2026-11-04T09:00:00Z', 'a')]).map((t) => t.body)).toEqual(['a', 'b']);
    const untimed: { body: string; createdAt?: Date }[] = [{ body: 'b' }, { body: 'a' }];
    expect(currentConversation(untimed).map((t) => t.body)).toEqual(['a', 'b']);
  });
});

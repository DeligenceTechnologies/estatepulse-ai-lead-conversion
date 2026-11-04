/**
 * The assistant's call-outcome tools: schedule_callback (an exact time the
 * lead asked to be called back), schedule_text (a time they asked to be
 * texted) and record_outcome (a clear "no", "stop contacting me" or wrong
 * number). They work on a call and in a text chat.
 */

export interface CallToolsSettings {
  /** The assistant has the tools; off removes them from Telnyx. */
  enabled: boolean;
  /** After a call on which a callback was set, text the lead the time. */
  confirmSms: boolean;
  /** {{firstName}}, {{callbackTime}} and the other lead variables are filled in. */
  confirmMessage: string;
  /** A callback the lead does not answer is called again this many minutes later… */
  retryMinutes: number;
  /** …this many times (0: not at all), before the lead goes to the no-answer follow-up. */
  retryAttempts: number;
  /** The AI may promise a text at the time the lead asks ("message me in 10 minutes"); off, it asks them to text back instead. */
  textBack: boolean;
  /** What that text says. {{firstName}}, {{brokerage}} and the other lead variables are filled in. */
  textBackMessage: string;
}

export const DEFAULT_RETRY_MINUTES = 15;
export const RETRY_MINUTES_MIN = 5;
export const RETRY_MINUTES_MAX = 240;
export const DEFAULT_RETRY_ATTEMPTS = 1;
export const RETRY_ATTEMPTS_MAX = 3;

const whole = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;

/** What was created on Telnyx for them; only the token's hash is kept here. */
export interface CallToolsTelnyx {
  tokenHash: string;
  secretId: string;
  secretIdentifier: string;
  toolIds: string[];
  assistantId: string;
  /** The API base the tools point at; a new one (a new tunnel, a new domain) provisions them again. */
  url: string;
  /** CALL_TOOLS_VERSION they were created with; an older one is provisioned again. */
  version?: number;
}

/** Bump when callToolDefinitions or the prompt section changes, so every assistant gets the new ones. */
export const CALL_TOOLS_VERSION = 5;

export type StoredCallTools = Partial<CallToolsSettings> & { telnyx?: CallToolsTelnyx | null };

export const DEFAULT_CONFIRM_MESSAGE =
  "Thanks {{firstName}}! I'll call you back on {{callbackTime}}. If another time suits you better, just reply here.";

export const CONFIRM_MESSAGE_MAX_CHARS = 320;

export const DEFAULT_TEXT_BACK_MESSAGE = "Hi {{firstName}}, it's {{brokerage}} again, following up as you asked. Is now a better time to chat?";

/** The greeting of the callback call itself, instead of the assistant's first-call greeting. */
export const CALLBACK_GREETING =
  "Hi {{firstName}}, it's the AI assistant from {{brokerage}}, calling you back as you asked. Is now still a good time?";

export function callToolsSettings(raw: unknown): CallToolsSettings & { telnyx: CallToolsTelnyx | null } {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as StoredCallTools) : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
    confirmSms: typeof v.confirmSms === 'boolean' ? v.confirmSms : true,
    confirmMessage: typeof v.confirmMessage === 'string' && v.confirmMessage.trim() ? v.confirmMessage.trim() : DEFAULT_CONFIRM_MESSAGE,
    retryMinutes: whole(v.retryMinutes, RETRY_MINUTES_MIN, RETRY_MINUTES_MAX, DEFAULT_RETRY_MINUTES),
    retryAttempts: whole(v.retryAttempts, 0, RETRY_ATTEMPTS_MAX, DEFAULT_RETRY_ATTEMPTS),
    textBack: typeof v.textBack === 'boolean' ? v.textBack : true,
    textBackMessage: typeof v.textBackMessage === 'string' && v.textBackMessage.trim() ? v.textBackMessage.trim() : DEFAULT_TEXT_BACK_MESSAGE,
    telnyx: v.telnyx?.tokenHash ? v.telnyx : null,
  };
}

export const CALL_TOOLS_PROMPT_START = '[EstatePulse: callbacks and outcomes — added by "Callbacks and outcomes" in AI Settings; turn it off there to remove]';
export const CALL_TOOLS_PROMPT_END = '[End of EstatePulse callbacks and outcomes]';

export function callToolsSection(): string {
  return [
    CALL_TOOLS_PROMPT_START,
    '# Callbacks and outcomes',
    '- If the lead is busy or asks to be called at another time, call schedule_callback: with day and time for a clock time ("tomorrow at 5"), with in_minutes for a delay ("in 5 minutes", "after an hour"), or with nothing if they named no time ("try me later"). Read back the returned "spoken" time, then say goodbye. If the result is not ok, offer the time it suggests. Never promise a callback without it.',
    '- If the lead asks to be texted or messaged later ("message me in 2 minutes", "text me tomorrow at 10"), call schedule_text the same way: day and time, in_minutes, or nothing. If they want to continue over text now ("message me right away", "let\'s chat on text", "send it now"), call schedule_text with in_minutes 1: the text arrives as soon as this call ends, and you carry on the conversation there. Confirm the returned "spoken" time in your reply. If the result is not ok, do what its "say" tells you. Never promise a text without it. A call later is schedule_callback and a text later is schedule_text; if a lead texting you only says "later", ask whether a text or a call suits them.',
    '- If the lead clearly says they are not interested or have already bought, call record_outcome with not_interested. If they ask us to stop calling or texting them, use do_not_contact. If this is not the person we wanted, or they never asked about buying a home, use wrong_number. Only on a clear statement, never on a guess. Then say one short, polite goodbye. Never argue or try to change their mind after do_not_contact.',
    '- If {{callback_due}} is yes, this call is the callback they asked for ({{callback_time}}). They have just heard that you are calling back, so go straight to helping them.',
    '- If {{call_context}} is not empty, it is why we are calling them this time. Let it guide the conversation, without reading it out.',
    CALL_TOOLS_PROMPT_END,
  ].join('\n');
}

export function withoutCallToolsSection(instructions: string): string {
  const start = instructions.indexOf(CALL_TOOLS_PROMPT_START);
  if (start < 0) return instructions;
  const endAt = instructions.indexOf(CALL_TOOLS_PROMPT_END, start);
  const end = endAt < 0 ? instructions.length : endAt + CALL_TOOLS_PROMPT_END.length;
  const before = instructions.slice(0, start).replace(/\n{1,2}$/, '');
  const after = instructions.slice(end).replace(/^\n/, '');
  return after ? `${before}\n${after}` : before;
}

export function withCallToolsSection(instructions: string): string {
  const base = withoutCallToolsSection(instructions ?? '').replace(/\s+$/, '');
  return base ? `${base}\n\n${callToolsSection()}` : callToolsSection();
}

export const OUTCOMES = ['not_interested', 'do_not_contact', 'wrong_number'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * The three tools as Telnyx webhook tools. lead_id, call_control_id and
 * end_user are preset: filled by Telnyx, out of the model's reach, which is
 * what ties a request to one live call or one chat.
 */
export function callToolDefinitions(apiUrl: string, secretIdentifier: string) {
  const shared = {
    method: 'POST',
    headers: [{ name: 'Authorization', value: `Bearer {{#integration_secret}}${secretIdentifier}{{/integration_secret}}` }],
    preset_body_fields: { lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}', end_user: '{{telnyx_end_user_target}}' },
  };
  return [
    {
      type: 'webhook',
      display_name: 'EstatePulse: schedule a callback',
      timeout_ms: 10000,
      webhook: {
        ...shared,
        name: 'schedule_callback',
        description:
          'Schedule a call back at the time the lead asks for, when they are busy now or want to talk later. For a clock ' +
          'time pass `day` (YYYY-MM-DD, "today", "tomorrow" or a weekday name) and `time` (24-hour HH:MM). For a delay ' +
          '("in 5 minutes", "after an hour", "in two hours") pass only `in_minutes`. Pass nothing if they named no time. ' +
          'Read back the returned `spoken` time. If the result is not ok, offer the suggested time instead.',
        url: `${apiUrl}/tools/telnyx/outcome/callback`,
        body_parameters: {
          type: 'object',
          properties: {
            day: { type: 'string', description: 'YYYY-MM-DD, "today", "tomorrow" or a weekday name. Omit if they named no day.' },
            time: { type: 'string', description: 'The time they asked for, 24-hour HH:MM, e.g. 17:00. Omit if they named no time.' },
            in_minutes: { type: 'integer', description: 'A delay they asked for instead of a clock time, in minutes: "in 5 minutes" is 5, "after an hour" is 60.' },
            note: { type: 'string', description: 'Why they want the callback, in a few words, if they said.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'webhook',
      display_name: 'EstatePulse: schedule a text',
      timeout_ms: 10000,
      webhook: {
        ...shared,
        name: 'schedule_text',
        description:
          'Schedule a text message to the lead at the time they ask to be texted or messaged later ("message me in 2 ' +
          'minutes", "text me tomorrow at 10"). For a clock time pass `day` (YYYY-MM-DD, "today", "tomorrow" or a ' +
          'weekday name) and `time` (24-hour HH:MM). For a delay pass only `in_minutes`. "Right away", "now" or "let\'s ' +
          'continue on text" is `in_minutes` 1: the text goes out as soon as the call ends. Pass nothing if they named no ' +
          'time. Confirm the returned `spoken` time. If the result is not ok, do what its `say` tells you.',
        url: `${apiUrl}/tools/telnyx/outcome/text`,
        body_parameters: {
          type: 'object',
          properties: {
            day: { type: 'string', description: 'YYYY-MM-DD, "today", "tomorrow" or a weekday name. Omit if they named no day.' },
            time: { type: 'string', description: 'The time they asked for, 24-hour HH:MM, e.g. 17:00. Omit if they named no time.' },
            in_minutes: { type: 'integer', description: 'A delay they asked for instead of a clock time, in minutes: "in 2 minutes" is 2, "after an hour" is 60.' },
            note: { type: 'string', description: 'Why they want the text later, in a few words, if they said.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'webhook',
      display_name: 'EstatePulse: record the outcome',
      timeout_ms: 10000,
      webhook: {
        ...shared,
        name: 'record_outcome',
        description:
          'Record how the conversation ended, only when the lead says it clearly: `not_interested` (they do not want to ' +
          'buy, or already bought), `do_not_contact` (they ask us to stop calling or texting them) or `wrong_number` ' +
          '(not the person we wanted, or they never asked about a home). Then say one short, polite goodbye.',
        url: `${apiUrl}/tools/telnyx/outcome/record`,
        body_parameters: {
          type: 'object',
          properties: {
            outcome: { type: 'string', enum: [...OUTCOMES], description: 'What the lead said.' },
            note: { type: 'string', description: 'Their words, briefly.' },
          },
          required: ['outcome'],
        },
      },
    },
  ];
}

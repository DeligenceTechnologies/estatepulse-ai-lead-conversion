import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '@/common/errors/app-error';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';
import { telnyx } from '../telnyx-api';

const MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

export const SMS_INTENTS = ['continue', 'not_interested', 'wrong_number', 'opt_out'] as const;
export type SmsIntent = (typeof SMS_INTENTS)[number];

const schema = z.object({ intent: z.enum(SMS_INTENTS), reason: z.string().max(300) });
export type SmsIntentResult = z.infer<typeof schema>;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'reason'],
  properties: {
    intent: {
      type: 'string',
      enum: [...SMS_INTENTS],
      description:
        'opt_out: asks us to stop texting or contacting them in any words. not_interested: clearly declines (not buying, already bought, ' +
        'no thanks). wrong_number: says they are not the person or never enquired. continue: anything else, including a bare "no" ' +
        'to a question, "not now", "later", questions, or answers.',
    },
    reason: { type: 'string', description: 'A few words quoting what in the message decided it.' },
  },
} as const;

const INSTRUCTIONS = [
  'You classify the newest text a home-buying lead sent to a real estate brokerage: does it end our outreach to them?',
  'Read the earlier messages for context, but judge only the newest one, by what the lead says about themselves now.',
  '- opt_out: they ask us to stop texting, calling or contacting them, in any words ("stop texting me", "remove me from your list").',
  '- not_interested: they are not buying or they decline ("not interested", "no thanks", "we already bought", "not looking anymore", "we decided to rent").',
  '- wrong_number: they are not the person we think or never asked about buying ("wrong number", "I never signed up for this").',
  '- continue: everything else. A bare "no" or "not right now" to a question, "maybe next year", "call me next week", questions such as "who is this?", and answers about their search are all continue.',
  'Examples: "No thanks, we already bought a house" → not_interested. "Not interested" → not_interested. "No" → continue.',
  '"Not right now, maybe next year" → continue. "Please stop texting me" → opt_out. "Wrong number" → wrong_number.',
  'Give the reason as a short quote from the message.',
].join('\n');

export interface SmsTurn {
  from: 'lead' | 'us';
  text: string;
}

/** Whether a lead's text ends the outreach: an opt-out in their own words, a clear no, or a wrong number. */
@Injectable()
export class SmsIntentService {
  constructor(private readonly creds: TelnyxCredentialsService) {}

  async classify(orgId: string, earlier: SmsTurn[], message: string): Promise<SmsIntentResult> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'Connect your Telnyx account first');
    const chat = earlier.map((t) => `${t.from === 'lead' ? 'Lead' : 'Us'}: ${t.text}`).join('\n');
    const res = await telnyx(c.apiKey, '/ai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: INSTRUCTIONS },
          { role: 'user', content: `Earlier messages:\n${chat || '(none)'}\n\nNewest message from the lead:\n${message}`.slice(0, 8000) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'sms_intent', schema: JSON_SCHEMA, strict: true } },
      }),
    });
    return parseIntent(res.choices?.[0]?.message?.content);
  }
}

/** The model's answer, or `continue` when it is unusable: never end a conversation on a garbled reply. */
export function parseIntent(raw: unknown): SmsIntentResult {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { intent: 'continue', reason: 'unreadable classification' };
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : { intent: 'continue', reason: 'unreadable classification' };
}

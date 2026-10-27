import type { StrategyStep } from './strategiesApi';
import type { StepDraft } from './sequencesApi';

/** When a strategy or sequence step runs; both set means both must hold. Unset: always. */
export interface StepConditions {
  /** Only if the last call was not answered (no answer, voicemail, busy, declined, hung up at once, failed). */
  lastCallMissed?: boolean;
  /** Only if the lead has not texted back since this journey started. */
  noReply?: boolean;
}

export type StepChannel = 'sms' | 'voice';

/**
 * A step's condition is about the step right before it: after a text, whether
 * the lead replied; after a call, whether it was answered. The first step has
 * nothing before it and always runs. The server applies the same rule on save,
 * and skips a step with a condition when the step before it was skipped.
 */
export const allowedConditions = (previous?: StepChannel) => ({ lastCallMissed: previous === 'voice', noReply: previous === 'sms' });

export function fitConditions(onlyIf: StepConditions | undefined, previous?: StepChannel): StepConditions | undefined {
  if (previous === 'voice' && onlyIf?.lastCallMissed) return { lastCallMissed: true };
  if (previous === 'sms' && onlyIf?.noReply) return { noReply: true };
  return undefined;
}

/** The steps with each condition refitted to its place, after any add, move, removal or channel change. */
export function fitSteps<T extends { onlyIf?: StepConditions }>(steps: T[], channelOf: (step: T) => StepChannel): T[] {
  return steps.map((step, i) => {
    const onlyIf = fitConditions(step.onlyIf, i > 0 ? channelOf(steps[i - 1]) : undefined);
    if (!!onlyIf?.lastCallMissed === !!step.onlyIf?.lastCallMissed && !!onlyIf?.noReply === !!step.onlyIf?.noReply) return step;
    return { ...step, onlyIf };
  });
}

/** On a call step: the AI Settings voicemail setting, always leave the message, or never leave one. */
export type StepVoicemail = 'default' | 'leave' | 'skip';

/** Per lead, per local day. 0 switches a limit off. */
export interface ContactLimits {
  callsPerDay: number;
  smsPerDay: number;
  /** Between two of our calls, or two of our texts. A text may follow a call sooner. */
  minGapMinutes: number;
}

export const DEFAULT_LIMITS: ContactLimits = { callsPerDay: 2, smsPerDay: 3, minGapMinutes: 10 };

export const CALL_CONTEXT_MAX_CHARS = 500;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The rules every step is held to, in the strategy and in every sequence. They are not settings. */
export const ALWAYS_ON_RULES = [
  'A booking, a do-not-contact request, "not interested" or a wrong number ends all outreach at once.',
  'Nothing canned is sent while the lead is texting with the AI; a call waits until the chat goes quiet.',
  'Nothing is sent over a call that is still ringing or live.',
  'After a real conversation, the rest of the steps stop and the call scoring decides what happens next.',
  'A callback the lead asked for comes first: nothing else reaches them before it.',
  'A lead who declined or was busy is not called again for 30 minutes.',
  'Quiet hours, days off and the daily limits below apply to every step. A step that cannot go now waits; it is never dropped.',
  'A step’s condition is about the step right before it. If that step was skipped, the step is skipped too.',
];

const id = () => `s${Math.random().toString(36).slice(2, 7)}`;

export interface StrategyPreset {
  key: string;
  name: string;
  description: string;
  steps: () => StrategyStep[];
}

/** Starting points for the outreach strategy. Every one can be edited after it is applied. */
export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    key: 'speed',
    name: 'Speed to lead',
    description: 'Text at once, call 5 minutes later, a "tried calling" text only if they missed it, and one more call the next day if they never replied.',
    steps: () => [
      {
        id: id(),
        channel: 'sms',
        action: 'send_sms',
        after: { value: 0, unit: 'minutes' },
        message: "Hi {{firstName}}, thanks for reaching out to {{brokerage}}! Are you looking to buy in the next few months? Reply anytime, or I'll give you a quick call.",
      },
      { id: id(), channel: 'voice', action: 'ai_call', after: { value: 5, unit: 'minutes' }, voicemail: 'skip' },
      {
        id: id(),
        channel: 'sms',
        action: 'send_sms',
        after: { value: 2, unit: 'minutes' },
        message: "Hi {{firstName}}, just tried you with a quick call about your home search. When's a good time to chat?",
        onlyIf: { lastCallMissed: true },
      },
      {
        id: id(),
        channel: 'voice',
        action: 'ai_call',
        after: { value: 1, unit: 'days' },
        onlyIf: { noReply: true },
        voicemail: 'leave',
        context: 'Second attempt after no reply to yesterday’s text and call. Keep it short and friendly.',
      },
    ],
  },
  {
    key: 'call-first',
    name: 'Call first',
    description: 'Call the moment the lead comes in, text only if the call was missed, and call once more a few hours later if they never replied.',
    steps: () => [
      { id: id(), channel: 'voice', action: 'ai_call', after: { value: 0, unit: 'minutes' }, voicemail: 'skip' },
      {
        id: id(),
        channel: 'sms',
        action: 'send_sms',
        after: { value: 2, unit: 'minutes' },
        message: 'Hi {{firstName}}, this is {{brokerage}} — just tried calling about your home search. Is now a good time, or should I try later?',
        onlyIf: { lastCallMissed: true },
      },
      {
        id: id(),
        channel: 'voice',
        action: 'ai_call',
        after: { value: 3, unit: 'hours' },
        onlyIf: { noReply: true },
        voicemail: 'leave',
        context: 'Second attempt; the first call went unanswered.',
      },
    ],
  },
  {
    key: 'text-only',
    name: 'Text only',
    description: 'No calls: a welcome text, then two gentle nudges only while the lead has not replied.',
    steps: () => [
      {
        id: id(),
        channel: 'sms',
        action: 'send_sms',
        after: { value: 0, unit: 'minutes' },
        message: 'Hi {{firstName}}, thanks for reaching out to {{brokerage}}! Are you looking to buy soon? Reply here anytime.',
      },
      {
        id: id(),
        channel: 'sms',
        action: 'send_sms',
        after: { value: 1, unit: 'days' },
        message: 'Hi {{firstName}}, still thinking about a move? Happy to help with homes, prices or financing.',
        onlyIf: { noReply: true },
      },
      {
        id: id(),
        channel: 'sms',
        action: 'send_sms',
        after: { value: 3, unit: 'days' },
        message: "Hi {{firstName}}, I'll leave it here for now — just reply whenever you're ready to look.",
        onlyIf: { noReply: true },
      },
    ],
  },
];

const DAY = 1440;

export interface SequencePreset {
  key: string;
  name: string;
  description: string;
  steps: () => StepDraft[];
}

/** Starting points for a follow-up sequence. */
export const SEQUENCE_PRESETS: SequencePreset[] = [
  {
    key: 'no-answer',
    name: 'No-answer nurture',
    description: 'For leads the strategy never reached: a call every few days, a text only when the call is missed, stopping as soon as they reply.',
    steps: () => [
      { actionType: 'voice', delayMinutes: DAY, voicePrompt: 'We have not reached them yet. Introduce yourself and ask about their home search.', maxAttempts: 1, voicemail: 'leave' },
      { actionType: 'sms', delayMinutes: 5, messageTemplate: 'Hi {{firstName}}, just tried calling from {{brokerage}}. Reply here whenever suits you.', maxAttempts: 1, onlyIf: { lastCallMissed: true } },
      { actionType: 'voice', delayMinutes: 3 * DAY, voicePrompt: 'Third attempt; keep it short.', maxAttempts: 1, onlyIf: { noReply: true }, voicemail: 'skip' },
      { actionType: 'sms', delayMinutes: 5, messageTemplate: "Hi {{firstName}}, tried you once more. I'll stop reaching out for now — reply anytime if you want help finding a home.", maxAttempts: 1, onlyIf: { lastCallMissed: true } },
    ],
  },
  {
    key: 'not-ready',
    name: 'Not ready yet',
    description: 'For leads who talked but are months away: light, friendly check-ins by text, then a call a month out.',
    steps: () => [
      { actionType: 'sms', delayMinutes: 7 * DAY, messageTemplate: 'Hi {{firstName}}, great chatting the other day. Anything new on your home search?', maxAttempts: 1 },
      { actionType: 'sms', delayMinutes: 14 * DAY, messageTemplate: 'Hi {{firstName}}, a few new homes just came on the market. Want me to send some over?', maxAttempts: 1, onlyIf: { noReply: true } },
      { actionType: 'voice', delayMinutes: 9 * DAY, voicePrompt: 'They said they were months away. Check whether their timeline has moved and offer a consultation.', maxAttempts: 1, voicemail: 'leave' },
    ],
  },
  {
    key: 'callback',
    name: 'Callback requested',
    description: 'For leads who asked to be called later without a time: one call the next day, then a text if it is missed.',
    steps: () => [
      { actionType: 'voice', delayMinutes: DAY, voicePrompt: 'They asked us to call back later. Mention that, and ask if now suits them.', maxAttempts: 1, voicemail: 'leave' },
      { actionType: 'sms', delayMinutes: 5, messageTemplate: 'Hi {{firstName}}, tried you as promised. When is a good time to talk?', maxAttempts: 1, onlyIf: { lastCallMissed: true } },
    ],
  },
];

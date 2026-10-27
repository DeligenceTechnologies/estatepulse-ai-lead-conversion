import { CallDisposition } from '@prisma/client';

/**
 * The rules a journey step (in the outreach strategy or a follow-up sequence)
 * is held to beyond the ones that always apply: when it runs at all, how a
 * call step treats an answering machine, and how often a lead may be
 * contacted. The always-on rules (a booking, an opt-out or a stated outcome
 * ends everything; nothing during an AI chat or over a live call; nothing
 * canned after a conversation; a callback the lead asked for comes first)
 * live in the engine and the runner and cannot be switched off.
 */

/** When a step runs. Both set: both must hold. Unset: always. */
export interface StepConditions {
  /** Only if the last call of this journey was not answered (no answer, voicemail, busy, declined, hung up at once, failed). */
  lastCallMissed?: boolean;
  /** Only if the lead has not texted back since this journey started. */
  noReply?: boolean;
}

/**
 * A step's condition is about the step right before it: after a text, whether
 * the lead has replied; after a call, whether it was answered. The first step
 * has nothing before it to check, so it always runs. Anything else is dropped.
 */
export function fitConditions(onlyIf: StepConditions | undefined, previous: 'sms' | 'voice' | undefined): StepConditions | undefined {
  if (previous === 'voice' && onlyIf?.lastCallMissed) return { lastCallMissed: true };
  if (previous === 'sms' && onlyIf?.noReply) return { noReply: true };
  return undefined;
}

/** On a call step: the organization's voicemail setting, always leave its message, or never leave one. */
export type StepVoicemail = 'default' | 'leave' | 'skip';
export const STEP_VOICEMAILS: readonly StepVoicemail[] = ['default', 'leave', 'skip'];

/** What the AI is told about why it is calling, at most this long. */
export const CALL_CONTEXT_MAX_CHARS = 500;

/** A call that ended without the lead talking to the AI. */
export const MISSED_DISPOSITIONS: readonly CallDisposition[] = [
  CallDisposition.no_answer,
  CallDisposition.voicemail,
  CallDisposition.busy,
  CallDisposition.rejected,
  CallDisposition.short,
  CallDisposition.failed,
];

export interface JourneyFacts {
  /** How the latest call of this journey ended; null before any call has ended. */
  lastCall: CallDisposition | null;
  /** The lead has texted back since this journey started. */
  replied: boolean;
  /** The step right before was skipped: what a condition would check never happened. */
  previousSkipped?: boolean;
}

/** Why a step's conditions are not met, for the step_skipped log line; null when it may run. */
export function unmetCondition(onlyIf: StepConditions | undefined, facts: JourneyFacts): string | null {
  // Otherwise "the last call wasn't answered" would answer for an older call than the step before.
  if ((onlyIf?.lastCallMissed || onlyIf?.noReply) && facts.previousSkipped) return 'Its condition is about the step before, which was skipped';
  if (onlyIf?.lastCallMissed) {
    if (!facts.lastCall) return 'Only if the last call was not answered, and no call has ended yet';
    if (!MISSED_DISPOSITIONS.includes(facts.lastCall)) return `Only if the last call was not answered, and it was (${facts.lastCall})`;
  }
  if (onlyIf?.noReply && facts.replied) return 'Only if the lead has not replied, and they have';
  return null;
}

/** How hard a lead may be pushed, per lead and per local day. 0 switches a limit off. */
export interface ContactLimits {
  callsPerDay: number;
  smsPerDay: number;
  /** Between two calls, or two texts, from us. A text may follow a call sooner, as speed to lead needs. */
  minGapMinutes: number;
  /** After a call the lead declined or was busy for, the next call waits this long (a callback they asked for does not). */
  redialGapMinutes: number;
  /** A follow-up sequence step waits this long after the lead's last text, so it never lands in a chat. */
  chatQuietMinutes: number;
}

export const DEFAULT_LIMITS: ContactLimits = { callsPerDay: 2, smsPerDay: 3, minGapMinutes: 10, redialGapMinutes: 30, chatQuietMinutes: 30 };

const whole = (value: unknown, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;

/** Stored limits, each one checked; anything missing or out of range is the default. */
export function limitsOf(raw: unknown): ContactLimits {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<ContactLimits>) : {};
  return {
    callsPerDay: whole(v.callsPerDay, 20, DEFAULT_LIMITS.callsPerDay),
    smsPerDay: whole(v.smsPerDay, 20, DEFAULT_LIMITS.smsPerDay),
    minGapMinutes: whole(v.minGapMinutes, 1440, DEFAULT_LIMITS.minGapMinutes),
    redialGapMinutes: whole(v.redialGapMinutes, 1440, DEFAULT_LIMITS.redialGapMinutes),
    chatQuietMinutes: whole(v.chatQuietMinutes, 1440, DEFAULT_LIMITS.chatQuietMinutes),
  };
}

/** How long a sequence gives a lead after its last step before closing out: an hour to 30 days, 48 hours unless set. */
export const CLOSE_OUT_HOURS = { min: 1, max: 720, default: 48 } as const;

/** Days of the week (0 = Sunday) nobody is contacted, in the organization's time zone. */
export function skipDaysOf(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

/**
 * When the next touch on one channel may happen: now, once the gap since the
 * last one has passed, or (the day's limit used up) at `tomorrow`, the start
 * of the next day's contact window. A deferred step waits; it is never lost.
 */
export function limitSlot(input: {
  channel: 'sms' | 'voice';
  now: Date;
  limits: ContactLimits;
  sentToday: number;
  lastAt: Date | null;
  tomorrow: Date;
}): { at: Date; reason: string | null } {
  const { channel, now, limits, sentToday, lastAt, tomorrow } = input;
  const limit = channel === 'voice' ? limits.callsPerDay : limits.smsPerDay;
  const noun = channel === 'voice' ? 'calls' : 'texts';
  if (limit > 0 && sentToday >= limit) return { at: tomorrow, reason: `Daily limit of ${limit} ${noun} reached` };
  const gapMs = limits.minGapMinutes * 60_000;
  if (gapMs > 0 && lastAt && lastAt.getTime() + gapMs > now.getTime()) {
    return { at: new Date(lastAt.getTime() + gapMs), reason: `Less than ${limits.minGapMinutes} min since the last of our ${noun}` };
  }
  return { at: now, reason: null };
}

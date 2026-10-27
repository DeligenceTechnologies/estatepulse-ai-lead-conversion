import { CALL_CONTEXT_MAX_CHARS, STEP_VOICEMAILS, type StepVoicemail } from '@/followup/journey';

export const DEFAULT_CALL_LIMIT = 5;

/** A call answered for at least this long was a conversation, not a pick-up-and-hang-up. */
export const CONVERSATION_MIN_SECS = 20;

export type CallSource = 'strategy' | 'followup' | 'callback';

export interface CallJobData {
  orgId: string;
  leadId: string;
  source: CallSource;
  sequenceId?: string;
  /** A callback: the time it was set for. The job is dropped when the lead's callback has since moved or been cleared. */
  callbackAt?: string;
  /** The one retry after Telnyx or the network failed the dial has been used. */
  dialRetried?: boolean;
  /** What the step that placed it wants from this call. */
  voicemail?: StepVoicemail;
  context?: string;
}

/**
 * What a journey step wants from one call, carried in the call's client_state
 * so every webhook of it (on whichever server) knows it.
 */
export interface CallIntent {
  voicemail?: StepVoicemail;
  context?: string;
}

/** The intent in a webhook's client_state; anything unreadable is none. */
export function callIntent(clientState: unknown): CallIntent {
  if (typeof clientState !== 'string' || !clientState) return {};
  try {
    const raw = JSON.parse(Buffer.from(clientState, 'base64').toString('utf8')) as Record<string, unknown>;
    const voicemail = STEP_VOICEMAILS.find((v) => v === raw.voicemail);
    const context = typeof raw.context === 'string' && raw.context.trim() ? raw.context.trim().slice(0, CALL_CONTEXT_MAX_CHARS) : undefined;
    return { ...(voicemail ? { voicemail } : {}), ...(context ? { context } : {}) };
  } catch {
    return {};
  }
}

export interface EnqueueCallOptions {
  dedupeKey: string;
}

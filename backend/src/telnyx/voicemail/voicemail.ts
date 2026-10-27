/** How an AI call treats an answering machine. */
export interface VoicemailSettings {
  /**
   * Answering-machine detection on every AI call (a per-call charge on the
   * organization's Telnyx account). Off: no detection, the assistant starts at
   * once, and the call analysis tells a voicemail from a conversation afterwards.
   */
  detect: boolean;
  /** With detection on: leave the message after the beep; off, hang up. */
  enabled: boolean;
  message: string;
}

export const DEFAULT_VOICEMAIL_MESSAGE =
  'Hi {{firstName}}, this is {{brokerage}} calling about your home search. Sorry I missed you. ' +
  'You can text this number back whenever it suits you. Thanks!';

/** About 30 seconds spoken: a voicemail longer than that is cut off by many carriers. */
export const VOICEMAIL_MAX_CHARS = 500;

/** Telnyx's pay-as-you-go list price for premium answering-machine detection, per call (telnyx.com/pricing/voice-api, Oct 2026). */
export const AMD_PRICE_PER_CALL_USD = 0.0065;

/** The stored setting with its defaults: detection on, the default message left. */
export function voicemailSettings(raw: unknown): VoicemailSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<VoicemailSettings>) : {};
  return {
    detect: typeof v.detect === 'boolean' ? v.detect : true,
    enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
    message: typeof v.message === 'string' && v.message.trim() ? v.message.trim() : DEFAULT_VOICEMAIL_MESSAGE,
  };
}

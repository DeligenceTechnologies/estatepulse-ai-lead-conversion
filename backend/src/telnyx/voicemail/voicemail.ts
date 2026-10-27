/** What an AI call says after the beep when an answering machine picks up. */
export interface VoicemailSettings {
  enabled: boolean;
  message: string;
}

export const DEFAULT_VOICEMAIL_MESSAGE =
  'Hi {{firstName}}, this is {{brokerage}} calling about your home search. Sorry I missed you. ' +
  'You can text this number back whenever it suits you. Thanks!';

/** About 30 seconds spoken: a voicemail longer than that is cut off by many carriers. */
export const VOICEMAIL_MAX_CHARS = 500;

/** The stored setting with its defaults: on, with the default message. */
export function voicemailSettings(raw: unknown): VoicemailSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<VoicemailSettings>) : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
    message: typeof v.message === 'string' && v.message.trim() ? v.message.trim() : DEFAULT_VOICEMAIL_MESSAGE,
  };
}

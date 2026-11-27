/**
 * The voices an admin can pick from in AI Settings → Voice & calls.
 *
 * The preferred voices are the English voices Telnyx documents for its TTS
 * API. At runtime they are checked against Telnyx's live voice list
 * (VoiceCatalogService), so an id Telnyx does not know never reaches a card.
 * Each one must still pass VOICE_QA.md (live call, voicemail, transfer) so a
 * lead hears the same voice everywhere. Any other voice id can be typed in
 * under "Advanced" as a custom voice.
 */
export interface CatalogVoice {
  /** Stable key, used by the UI and the preview endpoint. Never change one that has shipped. */
  key: string;
  name: string;
  /** A few words an admin can choose by, e.g. "Warm, female, US". */
  description: string;
  gender: 'female' | 'male' | 'unknown';
  /** BCP-47 language of the voice, e.g. en-US; sent with the preview request. */
  language: string;
  /** What Telnyx stores in the assistant's voice_settings.voice and what `speak` is given. */
  telnyxVoiceId: string;
}

/** Shown when Telnyx's voice list can't be read, and preferred over any other voice it lists. */
export const PREFERRED_VOICES: readonly CatalogVoice[] = [
  { key: 'brian', name: 'Brian', description: 'Clear, male, US', gender: 'male', language: 'en-US', telnyxVoiceId: 'Telnyx.Bayan.Brian' },
  { key: 'arjun', name: 'Arjun', description: 'Friendly, male, US', gender: 'male', language: 'en-US', telnyxVoiceId: 'Telnyx.Bayan.Arjun' },
  { key: 'danielle', name: 'Danielle', description: 'Professional, female, US', gender: 'female', language: 'en-US', telnyxVoiceId: 'aws.Polly.Danielle-Neural' },
  { key: 'gregory', name: 'Gregory', description: 'Calm, male, US', gender: 'male', language: 'en-US', telnyxVoiceId: 'aws.Polly.Gregory-Neural' },
  { key: 'heart', name: 'Heart', description: 'Bright, female, US', gender: 'female', language: 'en-US', telnyxVoiceId: 'Telnyx.KokoroTTS.af_heart' },
  { key: 'adam', name: 'Adam', description: 'Relaxed, male, US', gender: 'male', language: 'en-US', telnyxVoiceId: 'Telnyx.KokoroTTS.am_adam' },
  { key: 'emma', name: 'Emma', description: 'Polished, female, UK', gender: 'female', language: 'en-GB', telnyxVoiceId: 'Telnyx.KokoroTTS.bf_emma' },
];

export const MAX_CATALOG_VOICES = 8;

/** What a new assistant starts with: a Telnyx-hosted voice (seen in the live list), so no outside provider is involved. */
export const DEFAULT_VOICE_KEY = 'brian';

export const DEFAULT_VOICE_ID = PREFERRED_VOICES.find((v) => v.key === DEFAULT_VOICE_KEY)!.telnyxVoiceId;

/** Telnyx voice ids compare without regard to case (its docs write both "AWS.Polly" and "aws.Polly"). */
export const sameVoice = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The same English line for every preview, so voices are compared fairly. */
export const PREVIEW_TEXT =
  "Hi Sarah, this is your assistant from Sunny Homes. I saw you were looking at homes in Plano. Do you have a quick minute to chat?";

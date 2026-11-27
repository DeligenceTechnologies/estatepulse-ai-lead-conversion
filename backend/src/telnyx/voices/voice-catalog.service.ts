import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';
import { MAX_CATALOG_VOICES, PREFERRED_VOICES, PREVIEW_TEXT, sameVoice, type CatalogVoice } from './voice-catalog';

const TTS = 'https://api.telnyx.com/v2/text-to-speech';
/** Providers whose voices need no extra provider key: Telnyx's own and AWS Polly. */
const PROVIDERS = ['telnyx', 'aws'] as const;
const LIST_CACHE_MS = 6 * 60 * 60 * 1000;
// v2: the first build cached raw PCM from base64_output, which no browser plays; those files are never read again.
const PREVIEW_DIR = join(tmpdir(), 'estatepulse-voice-previews-v2');

/** The audio type of a clip from its first bytes, or null when it is not a file a browser can play (e.g. bare PCM). */
export function audioType(b: Buffer): string | null {
  if (b.length < 12) return null;
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  return null;
}

/** Bare 16-bit PCM wrapped in a WAV header, so a browser can play it. */
export function pcmToWav(pcm: Buffer, rate: number, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** One voice as GET /v2/text-to-speech/voices lists it. */
export interface TelnyxVoice {
  provider?: string;
  name?: string;
  voice_id: string;
  language?: string;
  gender?: string;
  hosted?: boolean;
}

/**
 * True for a voice that speaks English. Telnyx mislabels a few ids (e.g.
 * "Azure.fr-Multitalker:…" listed as en-US), so an id naming another language
 * is skipped whatever its label says.
 */
export function isEnglishVoice(v: TelnyxVoice): boolean {
  if (!v.voice_id || !v.language?.toLowerCase().startsWith('en')) return false;
  const named = /(?:^|[.:_])([a-z]{2})-[A-Za-z]/.exec(v.voice_id)?.[1];
  return !named || named === 'en';
}

/** One listed voice in our shape, tolerating the field names Telnyx might use; null when it has no id. */
export function toTelnyxVoice(raw: unknown): TelnyxVoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof r[k] === 'string' && (r[k] as string).trim()) return (r[k] as string).trim();
    return undefined;
  };
  const voice_id = str('voice_id', 'id', 'voice');
  if (!voice_id) return null;
  return {
    voice_id,
    provider: str('provider'),
    name: str('name', 'display_name'),
    language: str('language', 'language_code', 'locale', 'lang'),
    gender: str('gender'),
    hosted: typeof r.hosted === 'boolean' ? r.hosted : undefined,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const genderOf = (g?: string): CatalogVoice['gender'] => {
  const x = g?.toLowerCase();
  return x === 'female' || x === 'male' ? x : 'unknown';
};
const accentOf = (lang: string) => {
  const region = lang.split('-')[1]?.toUpperCase();
  return region === 'GB' || region === 'UK' ? 'UK' : region === 'AU' ? 'Australian' : region === 'US' ? 'US' : lang;
};

/**
 * The voice cards: the preferred voices Telnyx really offers, topped up from
 * its English voices, plus a recorded-once preview clip for each.
 */
@Injectable()
export class VoiceCatalogService {
  private readonly logger = new Logger(VoiceCatalogService.name);
  private listed: { voices: TelnyxVoice[]; until: number } | null = null;
  private readonly previews = new Map<string, Promise<{ audio: string; contentType: string }>>();
  /**
   * Voices Telnyx refused to speak (lower-cased ids). They come off the cards: a voice
   * TTS can't speak would fail on voicemail too. Kept until the server restarts.
   */
  private readonly unusable = new Set<string>();
  /** Preferred voices already reported missing, so the log says it once, not per click. */
  private readonly warnedMissing = new Set<string>();
  private usable = (id: string) => !this.unusable.has(id.toLowerCase());

  constructor(private readonly creds: TelnyxCredentialsService) {}

  /** The voices to show as cards. Falls back to the preferred list when Telnyx's list can't be read. */
  async catalog(orgId: string): Promise<CatalogVoice[]> {
    const live = await this.liveVoices(orgId).catch((error) => {
      this.logger.warn(`voice list unavailable, showing the preferred voices: ${(error as Error).message}`);
      return null;
    });
    if (!live) return PREFERRED_VOICES.filter((p) => this.usable(p.telnyxVoiceId));

    const english = live.filter(isEnglishVoice);
    const picked: CatalogVoice[] = [];
    for (const p of PREFERRED_VOICES) {
      // Our preferred voices are known to be English, so they only need to be listed, whatever their language label.
      if (!this.usable(p.telnyxVoiceId)) continue;
      const hit = live.find((v) => sameVoice(v.voice_id, p.telnyxVoiceId));
      // Telnyx's own spelling of the id, so what is saved matches what it lists.
      if (hit) picked.push({ ...p, telnyxVoiceId: hit.voice_id });
      else if (!this.warnedMissing.has(p.key)) {
        this.warnedMissing.add(p.key);
        this.logger.warn(`preferred voice ${p.telnyxVoiceId} is not in Telnyx's voice list; left off the cards`);
      }
    }
    for (const v of english) {
      if (picked.length >= MAX_CATALOG_VOICES) break;
      if (!this.usable(v.voice_id) || picked.some((p) => sameVoice(p.telnyxVoiceId, v.voice_id))) continue;
      const lang = v.language ?? 'en-US';
      const gender = genderOf(v.gender);
      const name = v.name?.trim() || v.voice_id.split('.').pop()!;
      picked.push({
        key: slug(v.voice_id),
        name,
        description: [gender === 'unknown' ? null : gender[0].toUpperCase() + gender.slice(1), accentOf(lang)].filter(Boolean).join(', '),
        gender,
        language: lang,
        telnyxVoiceId: v.voice_id,
      });
    }
    if (!picked.length) {
      // Never an empty picker: if nothing in Telnyx's list could be used, show the preferred voices.
      this.logger.warn(
        `none of Telnyx's ${live.length} voices could be used (${english.length} English); showing the preferred voices. First voice as listed: ${JSON.stringify(live[0]).slice(0, 300)}`,
      );
      return PREFERRED_VOICES.filter((p) => this.usable(p.telnyxVoiceId));
    }
    return picked.slice(0, MAX_CATALOG_VOICES);
  }

  /**
   * A short English clip of one card's voice, as base64 audio. Each voice is
   * synthesized once and kept, in memory and on disk, so a restart or a second
   * organization does not pay for it again.
   */
  async preview(orgId: string, key: string): Promise<{ audio: string; contentType: string }> {
    const voice = (await this.catalog(orgId)).find((v) => v.key === key);
    if (!voice) throw new AppError('NOT_FOUND', 'Unknown voice');
    const id = createHash('sha1').update(`${voice.telnyxVoiceId.toLowerCase()}\n${PREVIEW_TEXT}`).digest('hex');
    let clip = this.previews.get(id);
    if (!clip) {
      clip = this.loadOrSynthesize(orgId, id, voice);
      this.previews.set(id, clip);
      // A failure is not kept: the next click tries again.
      clip.catch(() => this.previews.delete(id));
    }
    return clip;
  }

  private async loadOrSynthesize(orgId: string, id: string, voice: CatalogVoice): Promise<{ audio: string; contentType: string }> {
    const file = join(PREVIEW_DIR, `${id}.audio`);
    const cached = await readFile(file).catch(() => null);
    // Only a playable file counts as cached; anything else is made again.
    const cachedType = cached ? audioType(cached) : null;
    if (cached && cachedType) return { audio: cached.toString('base64'), contentType: cachedType };

    const apiKey = await this.apiKey(orgId);
    const audio = await this.synthesize(apiKey, voice);
    await mkdir(PREVIEW_DIR, { recursive: true })
      .then(() => writeFile(file, audio))
      .catch((error) => this.logger.warn(`voice preview not saved to disk: ${(error as Error).message}`));
    return { audio: audio.toString('base64'), contentType: audioType(audio)! };
  }

  /**
   * One clip from Telnyx's REST TTS. It asks for the default output, raw audio,
   * the same as a plain Postman call, and also accepts a JSON body with
   * base64_audio. Every failure becomes a worded error, never a bare 500.
   */
  private async synthesize(apiKey: string, voice: CatalogVoice): Promise<Buffer> {
    // Only the providers that read `language` get it (AWS Polly, Azure); Telnyx's own voices are sent exactly like Postman.
    const takesLanguage = /^(aws|azure)\./i.test(voice.telnyxVoiceId);
    const body: Record<string, string> = { text: PREVIEW_TEXT, voice: voice.telnyxVoiceId };
    if (takesLanguage) body.language = voice.language.toLowerCase().startsWith('en') ? voice.language : 'en-US';

    let res: Response;
    try {
      res = await fetch(`${TTS}/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg, application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.logger.warn(`voice preview for ${voice.telnyxVoiceId}: request failed: ${(error as Error).message}`);
      throw new AppError('UPSTREAM_ERROR', `Couldn't reach the voice provider for a sample of ${voice.name}. Try again in a moment.`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      this.logger.warn(`voice preview for ${voice.telnyxVoiceId} failed ${res.status}: ${detail}`);
      // 400/404/422: Telnyx won't speak this voice, so it comes off the cards. Other errors (key, rate limit, outage) may pass.
      if ([400, 404, 422].includes(res.status)) {
        this.unusable.add(voice.telnyxVoiceId.toLowerCase());
        throw new AppError('UPSTREAM_ERROR', `${voice.name} isn't available on your voice provider, so it was removed from the list.`);
      }
      throw new AppError('UPSTREAM_ERROR', `Couldn't make a sample of ${voice.name} right now (${res.status}). Try again in a moment.`);
    }

    const type = res.headers.get('content-type') ?? '';
    const bytes = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    let audio = bytes;
    if (type.includes('json')) {
      let j: { base64_audio?: string; data?: { base64_audio?: string } } = {};
      try {
        j = JSON.parse(bytes.toString('utf8'));
      } catch {
        /* handled below */
      }
      const b64 = j.base64_audio ?? j.data?.base64_audio;
      audio = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
    }
    if (!audio.length) {
      this.logger.warn(`voice preview for ${voice.telnyxVoiceId}: no audio in the reply (${type || 'no content type'}, ${bytes.length} bytes)`);
      throw new AppError('UPSTREAM_ERROR', `The voice provider sent no audio for ${voice.name}. Try again in a moment.`);
    }
    if (!audioType(audio)) {
      // Bare PCM: playable only with a header. The rate comes from the content type (e.g. "audio/L16; rate=24000").
      const rate = Number(/rate=(\d+)/i.exec(type)?.[1]);
      if (rate > 0) audio = pcmToWav(audio, rate, Number(/channels=(\d+)/i.exec(type)?.[1]) || 1);
    }
    if (!audioType(audio)) {
      this.logger.warn(
        `voice preview for ${voice.telnyxVoiceId}: reply is not a playable audio file (${type || 'no content type'}, ${audio.length} bytes, starts ${audio.subarray(0, 8).toString('hex')})`,
      );
      throw new AppError('UPSTREAM_ERROR', `The voice provider sent ${voice.name}'s sample in a format we can't play yet.`);
    }
    this.logger.log(`voice preview for ${voice.telnyxVoiceId}: ${audio.length} bytes (${type || 'no content type'})`);
    return audio;
  }

  /** Telnyx's English-capable voices for the providers we use, read at most every LIST_CACHE_MS. */
  private async liveVoices(orgId: string): Promise<TelnyxVoice[]> {
    if (this.listed && this.listed.until > Date.now()) return this.listed.voices;
    const apiKey = await this.apiKey(orgId);
    const lists = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const res = await fetch(`${TTS}/voices?provider=${provider}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res.ok) throw new Error(`voices?provider=${provider} returned ${res.status}`);
        const j = (await res.json()) as { voices?: unknown[]; data?: { voices?: unknown[] } | unknown[] };
        const raw = j.voices ?? (Array.isArray(j.data) ? j.data : j.data?.voices) ?? [];
        this.logger.log(`Telnyx lists ${raw.length} ${provider} voices`);
        return raw.map(toTelnyxVoice).filter((v): v is TelnyxVoice => v !== null);
      }),
    );
    const voices = lists.flat();
    if (!voices.length) throw new Error('Telnyx listed no voices');
    this.listed = { voices, until: Date.now() + LIST_CACHE_MS };
    return voices;
  }

  private async apiKey(orgId: string): Promise<string> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'No AI provider connected — add your credentials first.');
    return c.apiKey;
  }
}

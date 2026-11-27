import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, Buffer>();
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (f: string) => {
    if (!disk.has(f)) throw new Error('ENOENT');
    return disk.get(f);
  }),
  writeFile: vi.fn(async (f: string, b: Buffer) => void disk.set(f, b)),
}));

import { AssistantService } from '../assistant.service';
import { DEFAULT_VOICE_ID, PREFERRED_VOICES, PREVIEW_TEXT } from './voice-catalog';
import { VoiceCatalogService, isEnglishVoice } from './voice-catalog.service';

const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })), saveCreds: vi.fn(async () => undefined) };

type Call = { url: string; method: string; body?: any };
let calls: Call[];
let listed: Record<string, any[]>;
let speechOk: boolean;
let speechJson: boolean;
let speechType: string;
let speechBytes: ((voice: string) => Buffer) | null;
/** A minimal MP3: an ID3 tag, then the voice id so a test can tell clips apart. */
const ID3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1');
const mp3 = (voice: string) => Buffer.concat([ID3, Buffer.from(`:${voice}`)]);
const said = (b64: string) => Buffer.from(b64, 'base64').subarray(ID3.length).toString();

beforeEach(() => {
  calls = [];
  disk.clear();
  speechOk = true;
  speechJson = false;
  speechType = 'audio/mpeg';
  speechBytes = null;
  listed = {
    telnyx: [
      // As Telnyx really lists them: `id`, not `voice_id`.
      { id: 'Telnyx.Bayan.Brian', label: 'en', name: 'Brian', accent: 'English', language: 'en-US', provider: 'telnyx', gender: 'male', hosted: true },
      { id: 'Telnyx.Bayan.Arjun', label: 'eng', name: 'Arjun', accent: 'English', language: 'en-US', provider: 'telnyx', gender: 'male', hosted: true },
      { id: 'Telnyx.Bayan.Ayman', label: 'irq', name: 'Ayman', accent: 'Iraqi', language: 'ar-IQ', provider: 'telnyx', gender: 'male', hosted: true },
      { provider: 'telnyx', name: 'Heart', voice_id: 'Telnyx.KokoroTTS.af_heart', language: 'en-US', gender: 'Female' },
      { provider: 'telnyx', name: 'Sana', voice_id: 'Telnyx.Ultra.47651485', language: 'ur', gender: 'Female' },
      { provider: 'telnyx', name: 'Nova', voice_id: 'Telnyx.Ultra.Nova', language: 'en-AU', gender: 'Female' },
      { provider: 'telnyx', name: 'Leo', voice_id: 'Telnyx.Ultra.Leo', language: 'en-GB', gender: 'Male' },
      { provider: 'telnyx', name: 'Ivy', voice_id: 'Telnyx.Ultra.Ivy', language: 'en-US', gender: 'Female' },
    ],
    aws: [
      { provider: 'aws', name: 'Danielle', voice_id: 'aws.Polly.Danielle-Neural', language: 'en-US', gender: 'Female' },
      { provider: 'aws', name: 'Gregory', voice_id: 'aws.Polly.Gregory-Neural', language: 'en-US', gender: 'Male' },
      { provider: 'aws', name: 'Lucia', voice_id: 'aws.Polly.Lucia-Generative', language: 'es-ES', gender: 'Female' },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.includes('/text-to-speech/voices')) {
        const provider = new URL(url).searchParams.get('provider')!;
        return { ok: true, status: 200, json: async () => ({ voices: listed[provider] ?? [] }), text: async () => '' };
      }
      if (url.endsWith('/text-to-speech/speech')) {
        if (!speechOk) return { ok: false, status: 422, json: async () => ({}), text: async () => 'bad voice' };
        const bytes = speechBytes ? speechBytes(body.voice) : mp3(body.voice);
        if (speechJson) {
          const json = Buffer.from(JSON.stringify({ base64_audio: bytes.toString('base64') }));
          return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), arrayBuffer: async () => json, text: async () => '' };
        }
        return { ok: true, status: 200, headers: new Headers({ 'content-type': speechType }), arrayBuffer: async () => bytes, text: async () => '' };
      }
      // The assistant API.
      const data = method === 'POST' ? { id: 'assistant-new', ...body } : {};
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('isEnglishVoice', () => {
  it('keeps English voices and drops other languages, even when the label says English', () => {
    expect(isEnglishVoice({ voice_id: 'Telnyx.Ultra.Clara', language: 'en-US' })).toBe(true);
    expect(isEnglishVoice({ voice_id: 'Azure.en-US-AvaNeural', language: 'en-US' })).toBe(true);
    expect(isEnglishVoice({ voice_id: 'aws.Polly.Lucia-Generative', language: 'es-ES' })).toBe(false);
    expect(isEnglishVoice({ voice_id: 'Azure.fr-Multitalker:DragonHDLatestNeural', language: 'en-US' })).toBe(false);
    expect(isEnglishVoice({ voice_id: 'Telnyx.Ultra.x', language: undefined })).toBe(false);
  });
});

describe('the voice cards', () => {
  it('shows the preferred voices Telnyx offers and tops up to 8 from its English voices', async () => {
    const voices = await new VoiceCatalogService(creds as any).catalog('org-1');
    expect(voices).toHaveLength(8);
    // The preferred voices Telnyx lists come first, in order; am_adam and bf_emma aren't listed here.
    expect(voices.slice(0, 5).map((v) => v.key)).toEqual(['brian', 'arjun', 'danielle', 'gregory', 'heart']);
    const extra = voices.slice(5);
    expect(extra.map((v) => v.telnyxVoiceId)).toEqual(['Telnyx.Ultra.Nova', 'Telnyx.Ultra.Leo', 'Telnyx.Ultra.Ivy']);
    expect(extra.map((v) => v.description)).toEqual(['Female, Australian', 'Male, UK', 'Female, US']);
    expect(voices.some((v) => v.language.startsWith('es') || v.language.startsWith('ar') || v.language === 'ur')).toBe(false);
  });

  it('never shows an empty picker: falls back to the preferred voices when none of the listed ones can be used', async () => {
    listed = { telnyx: [{ voice_id: 'Telnyx.Ultra.Sana', language: 'ur' }], aws: [] };
    expect(await new VoiceCatalogService(creds as any).catalog('org-1')).toEqual(PREFERRED_VOICES);
  });

  it('reads other field names for the id and language', async () => {
    listed = { telnyx: [{ id: 'Telnyx.Bayan.Brian', locale: 'en-US', gender: 'male' }, { id: 'Telnyx.Ultra.Nova', language_code: 'en-AU' }], aws: [] };
    const voices = await new VoiceCatalogService(creds as any).catalog('org-1');
    expect(voices.map((v) => v.telnyxVoiceId)).toEqual(['Telnyx.Bayan.Brian', 'Telnyx.Ultra.Nova']);
  });

  it('keeps a preferred voice that Telnyx lists without a language', async () => {
    listed = { telnyx: [{ voice_id: 'telnyx.bayan.brian' }], aws: [] };
    const voices = await new VoiceCatalogService(creds as any).catalog('org-1');
    expect(voices.map((v) => v.telnyxVoiceId)).toEqual(['telnyx.bayan.brian']);
  });

  it("falls back to the preferred voices when Telnyx's list can't be read", async () => {
    listed = {};
    const voices = await new VoiceCatalogService(creds as any).catalog('org-1');
    expect(voices).toEqual(PREFERRED_VOICES);
  });

  it('reads the voice list once, not per request', async () => {
    const service = new VoiceCatalogService(creds as any);
    await service.catalog('org-1');
    await service.catalog('org-1');
    expect(calls.filter((c) => c.url.includes('/voices')).length).toBe(2); // telnyx + aws, once
  });
});

describe('a voice preview', () => {
  it('asks Telnyx for the English sample line in that voice, as base64', async () => {
    const service = new VoiceCatalogService(creds as any);
    const clip = await service.preview('org-1', 'danielle');
    expect(said(clip.audio)).toBe(':aws.Polly.Danielle-Neural');
    expect(clip.contentType).toBe('audio/mpeg');
    const speech = calls.find((c) => c.url.endsWith('/speech'))!;
    expect(speech.body).toEqual({ text: PREVIEW_TEXT, voice: 'aws.Polly.Danielle-Neural', language: 'en-US' });
  });

  it("sends a Telnyx voice exactly like a plain call: text and voice only", async () => {
    await new VoiceCatalogService(creds as any).preview('org-1', 'brian');
    expect(calls.find((c) => c.url.endsWith('/speech'))!.body).toEqual({ text: PREVIEW_TEXT, voice: 'Telnyx.Bayan.Brian' });
  });

  it('also reads a JSON reply with base64_audio', async () => {
    speechJson = true;
    const clip = await new VoiceCatalogService(creds as any).preview('org-1', 'arjun');
    expect(said(clip.audio)).toBe(':Telnyx.Bayan.Arjun');
  });

  it('wraps bare PCM in a WAV header when the reply says its rate', async () => {
    speechType = 'audio/L16; rate=24000; channels=1';
    speechBytes = () => Buffer.alloc(4800, 1);
    const clip = await new VoiceCatalogService(creds as any).preview('org-1', 'heart');
    const wav = Buffer.from(clip.audio, 'base64');
    expect(clip.contentType).toBe('audio/wav');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.length).toBe(44 + 4800);
  });

  it('refuses a reply that is not playable audio, with a worded error', async () => {
    speechType = 'application/octet-stream';
    speechBytes = () => Buffer.alloc(4800, 0);
    await expect(new VoiceCatalogService(creds as any).preview('org-1', 'heart')).rejects.toThrow("format we can't play");
  });

  it('makes a clip again when the cached file is not playable (the first build cached bare PCM)', async () => {
    await new VoiceCatalogService(creds as any).preview('org-1', 'heart');
    expect(disk.size).toBe(1);
    for (const f of disk.keys()) disk.set(f, Buffer.alloc(100, 0));
    const clip = await new VoiceCatalogService(creds as any).preview('org-1', 'heart');
    expect(said(clip.audio)).toBe(':Telnyx.KokoroTTS.af_heart');
    expect(calls.filter((c) => c.url.endsWith('/speech'))).toHaveLength(2);
  });

  it('turns an unreachable provider into a worded error, not a crash', async () => {
    const service = new VoiceCatalogService(creds as any);
    await service.catalog('org-1');
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (String(url).endsWith('/speech')) throw new TypeError('fetch failed');
      return (real as any)(url, init);
    }));
    await expect(service.preview('org-1', 'heart')).rejects.toThrow("Couldn't reach the voice provider");
  });

  it('is made once and then served from cache, also after a restart', async () => {
    await new VoiceCatalogService(creds as any).preview('org-1', 'brian');
    const again = new VoiceCatalogService(creds as any);
    await again.preview('org-1', 'brian');
    await again.preview('org-1', 'brian');
    expect(calls.filter((c) => c.url.endsWith('/speech'))).toHaveLength(1);
  });

  it('refuses a key that is not a card, without calling TTS', async () => {
    await expect(new VoiceCatalogService(creds as any).preview('org-1', 'nope')).rejects.toThrow('Unknown voice');
    expect(calls.some((c) => c.url.endsWith('/speech'))).toBe(false);
  });

  it('takes a voice Telnyx refuses to speak off the cards', async () => {
    const service = new VoiceCatalogService(creds as any);
    speechOk = false;
    await expect(service.preview('org-1', 'brian')).rejects.toThrow("isn't available");
    speechOk = true;
    // Refused with 422: Brian is off the cards from now on (the mock lists only 7 other English voices).
    const voices = await service.catalog('org-1');
    expect(voices.map((v) => v.key)).not.toContain('brian');
    expect(voices).toHaveLength(7);
    await expect(service.preview('org-1', 'arjun')).resolves.toMatchObject({ contentType: 'audio/mpeg' });
  });
});

describe('a new assistant', () => {
  it('starts with the default card voice', async () => {
    const prisma = {
      organizationSetting: {
        findUnique: vi.fn(async () => ({ callRecordingEnabled: false, callRecordingAnnounce: false, inCallBooking: null, callTools: null })),
        updateMany: vi.fn(async () => ({})),
      },
    };
    const service = new AssistantService(creds as any, prisma as any, { isEnabled: vi.fn(async () => false) } as any, { get: vi.fn(async () => []) } as any);
    await service.createAssistant('org-1', { model: 'model-1' });
    const created = calls.find((c) => c.method === 'POST' && c.url.includes('/ai/assistants'))!.body;
    expect(created.voice_settings).toEqual({ voice: DEFAULT_VOICE_ID });
    expect(DEFAULT_VOICE_ID).toBe('Telnyx.Bayan.Brian');
  });
});

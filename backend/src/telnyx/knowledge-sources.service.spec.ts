import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeSourcesService, MAX_FILE_BYTES, sourceFileName, sourceFileType, websiteUrl } from './knowledge-sources.service';

/**
 * The documents and websites behind the AI's knowledge base. Telnyx is faked at
 * `fetch`: these cover which Telnyx calls are made for whom, that nothing from
 * a request can name a bucket, and that the API key never reaches a log or an
 * error message.
 */

const API_KEY = 'KEY_SECRET_123';
const ORG = '019a0000-0000-7000-8000-000000000001';
const ASSISTANT = 'assistant-aaaa-bbbb-1234abcd';
/** The name a knowledge base made by EstatePulse gets: the org and the assistant, nothing from a request. */
const OWN_BUCKET = `ep-kb-${ORG.replace(/-/g, '')}-1234abcd`;
const PDF = Buffer.from('%PDF-1.7 fake');

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function setup(
  options: {
    kb?: { bucket: string; shared?: boolean } | null;
    /** What Telnyx says it has read. */
    files?: any[];
    /** What is actually in the bucket; the same names as `files` unless given. */
    objects?: string[];
    storageDown?: boolean;
    embedded?: string[];
    creds?: any;
  } = {},
) {
  const calls: Call[] = [];
  let kb = options.kb === undefined ? null : options.kb;
  const files = options.files ?? [];
  const objects = options.objects ?? files.map((f) => f.filename);
  const fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url, headers: init.headers ?? {}, body: init.body });
    const xml = (body: string, status = 200) => new Response(method === 'HEAD' ? null : body, { status, headers: { 'content-type': 'application/xml' } });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('telnyxcloudstorage.com')) {
      if (options.storageDown) return xml('<Error><Code>ServiceUnavailable</Code></Error>', 503);
      if (url.endsWith('?location')) return xml('<LocationConstraint xmlns="x">us-east-1</LocationConstraint>');
      if (url.includes('?list-type=2')) {
        const escaped = objects.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('');
        return xml(`<ListBucketResult>${escaped}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      return xml('');
    }
    if (url.endsWith('/ai/embeddings/buckets')) return json({ data: { buckets: options.embedded ?? [] } });
    if (url.includes('/ai/embeddings/buckets/')) return json({ data: files });
    if (url.endsWith('/ai/embeddings/url') || url.endsWith('/ai/embeddings')) return json({ data: { task_id: 't1', status: 'queued' } });
    return json({ errors: [{ title: 'unexpected call' }] }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);

  const creds = { getCreds: vi.fn(async () => (options.creds === undefined ? { apiKey: API_KEY, assistantId: ASSISTANT } : options.creds)) };
  const assistants = {
    retrieval: vi.fn(async () => (kb ? { shared: false, ...kb } : null)),
    setRetrieval: vi.fn(async (_org: string, bucket: string) => {
      kb = { bucket };
    }),
  };
  const service = new KnowledgeSourcesService(creds as any, assistants as any);
  const lines: string[] = [];
  (service as any).logger = { log: (t: unknown) => lines.push(String(t)), warn: (t: unknown) => lines.push(String(t)) };
  const storage = () => calls.filter((c) => c.url.includes('telnyxcloudstorage.com'));
  return { service, calls, storage, assistants, creds, lines };
}

afterEach(() => vi.unstubAllGlobals());

describe('validating what an owner adds', () => {
  it('keeps a file name to its own name, with no path in it', () => {
    expect(sourceFileName('C:\\Users\\me\\Fee schedule 2026.pdf')).toBe('Fee schedule 2026.pdf');
    expect(sourceFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sourceFileName('weird*name?.txt')).toBe('weird_name_.txt');
    expect(sourceFileName('...')).toBe('');
  });

  it('takes the type from the extension and checks it against the bytes', () => {
    expect(sourceFileType('guide.pdf', PDF)).toBe('application/pdf');
    expect(sourceFileType('notes.txt', Buffer.from('plain words'))).toBe('text/plain');
    expect(() => sourceFileType('guide.pdf', Buffer.from('not a pdf'))).toThrow(/not a PDF/);
    expect(() => sourceFileType('notes.txt', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toThrow(/not a text file/);
    expect(() => sourceFileType('notes.txt', Buffer.from([65, 0, 66]))).toThrow(/not a text file/);
  });

  it('turns away a Word document and anything else Telnyx does not list', () => {
    expect(() => sourceFileType('guide.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toThrow(/PDF/);
    expect(() => sourceFileType('run.exe', Buffer.from('MZ'))).toThrow();
    expect(() => sourceFileType('noextension', Buffer.from('x'))).toThrow();
  });

  it('accepts a public web address only', () => {
    expect(websiteUrl(' https://www.example.com/about#team ')).toBe('https://www.example.com/about');
    for (const bad of ['example.com', 'ftp://example.com', 'http://localhost:3000', 'http://127.0.0.1/', 'http://[::1]/', 'https://user:pw@example.com', 'javascript:alert(1)']) {
      expect(() => websiteUrl(bad), bad).toThrow();
    }
  });
});

describe('the knowledge base status', () => {
  it('is unavailable, and calls nothing, without Telnyx or an assistant', async () => {
    for (const creds of [null, { apiKey: '', assistantId: ASSISTANT }, { apiKey: API_KEY, assistantId: '' }]) {
      const s = setup({ creds });
      const status = await s.service.status(ORG);
      expect(status.available).toBe(false);
      expect(s.calls).toEqual([]);
    }
  });

  it('lists the files of the bucket the assistant itself names, with plain statuses', async () => {
    const s = setup({
      kb: { bucket: 'made-in-portal' },
      files: [
        { filename: 'b.pdf', status: 'success', last_embedded_at: '2026-11-19T09:38:45', error_reason: null },
        { filename: 'a.txt', status: 'processing', created_at: '2026-11-19T09:00:00' },
        { filename: 'c.csv', status: 'failure', error_reason: 'could not parse' },
        { filename: 'https://example.com/about', status: 'queued' },
      ],
    });
    const status = await s.service.status(ORG);
    expect(status.sources.map((x) => [x.name, x.status, x.kind])).toEqual([
      ['a.txt', 'processing', 'file'],
      ['b.pdf', 'ready', 'file'],
      ['c.csv', 'failed', 'file'],
      ['https://example.com/about', 'processing', 'website'],
    ]);
    expect(status.sources[2].error).toBe('could not parse');
    expect(JSON.stringify(status)).not.toContain('made-in-portal');
  });

  it('shows a file Telnyx is still reading, though Telnyx does not list it yet', async () => {
    // What happened live: a replaced file left Telnyx's list for ~40s and the card said "Nothing yet".
    const s = setup({ kb: { bucket: 'b' }, files: [], objects: ['Fee schedule.pdf'] });
    const status = await s.service.status(ORG);
    expect(status.sources).toEqual([{ name: 'Fee schedule.pdf', kind: 'file', status: 'processing', error: null }]);
  });

  it('does not show a removed file that Telnyx has not dropped from its list yet', async () => {
    const s = setup({ kb: { bucket: 'b' }, files: [{ filename: 'gone.txt', status: 'success' }, { filename: 'kept.txt', status: 'success' }], objects: ['kept.txt'] });
    expect((await s.service.status(ORG)).sources.map((x) => x.name)).toEqual(['kept.txt']);
  });

  it('reads the file list from the bucket\'s own region, and decodes names', async () => {
    const s = setup({ kb: { bucket: 'b' }, files: [], objects: ['Q&A.txt'] });
    expect((await s.service.status(ORG)).sources[0].name).toBe('Q&A.txt');
    expect(s.storage().some((c) => c.url.startsWith('https://us-east-1.telnyxcloudstorage.com/b?list-type=2'))).toBe(true);
  });

  it('falls back to what Telnyx has read when storage cannot be reached', async () => {
    const s = setup({ kb: { bucket: 'b' }, files: [{ filename: 'a.txt', status: 'success' }], storageDown: true });
    expect((await s.service.status(ORG)).sources.map((x) => [x.name, x.status])).toEqual([['a.txt', 'ready']]);
  });

  it('says so when the knowledge base is a shared Telnyx tool', async () => {
    const s = setup({ kb: { bucket: 'shared-one', shared: true } });
    expect((await s.service.status(ORG)).managedInTelnyx).toBe(true);
  });
});

describe('adding a document', () => {
  it('makes the knowledge base on first use: bucket, file, first embed, then the assistant is pointed at it', async () => {
    const s = setup();
    await s.service.addFile(ORG, { originalname: 'Buyer guide.pdf', size: PDF.length, buffer: PDF });

    const [create, put] = s.storage().filter((c) => c.method === 'PUT');
    expect(create.method).toBe('PUT');
    expect(create.url).toBe(`https://us-central-1.telnyxcloudstorage.com/${OWN_BUCKET}`);
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`https://us-central-1.telnyxcloudstorage.com/${OWN_BUCKET}/Buyer%20guide.pdf`);
    expect(put.headers['Content-Type']).toBe('application/pdf');

    const embed = s.calls.find((c) => c.url.endsWith('/ai/embeddings') && c.method === 'POST');
    expect(JSON.parse(String(embed!.body))).toEqual({ bucket_name: OWN_BUCKET });
    expect(s.assistants.setRetrieval).toHaveBeenCalledWith(ORG, OWN_BUCKET);
    // Attached last, once something is in it.
    expect(s.assistants.setRetrieval.mock.invocationCallOrder[0]).toBeGreaterThan(fetchOrderOf(s, embed!));
  });

  it('uses an existing knowledge base in its own region, and neither re-embeds nor re-attaches it', async () => {
    const s = setup({ kb: { bucket: 'made-in-portal' }, embedded: ['made-in-portal'] });
    await s.service.addFile(ORG, { originalname: 'notes.txt', size: 5, buffer: Buffer.from('hello') });
    const put = s.storage().find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('https://us-east-1.telnyxcloudstorage.com/made-in-portal/notes.txt');
    expect(s.storage().filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(s.calls.some((c) => c.url.endsWith('/ai/embeddings') && c.method === 'POST')).toBe(false);
    expect(s.assistants.setRetrieval).not.toHaveBeenCalled();
  });

  it('sends the API key as the storage access key id and nowhere else', async () => {
    const s = setup();
    await s.service.addFile(ORG, { originalname: 'notes.txt', size: 5, buffer: Buffer.from('hello') });
    for (const c of s.storage()) {
      expect(c.headers.Authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${API_KEY}/`));
      expect(c.url).not.toContain(API_KEY);
    }
  });

  it('refuses a bad file before any Telnyx call', async () => {
    const s = setup();
    await expect(s.service.addFile(ORG, undefined)).rejects.toThrow(/Choose a file/);
    await expect(s.service.addFile(ORG, { originalname: 'big.pdf', size: MAX_FILE_BYTES + 1, buffer: PDF })).rejects.toThrow(/too large/);
    await expect(s.service.addFile(ORG, { originalname: 'guide.docx', size: 4, buffer: Buffer.from('PK\u0003\u0004') })).rejects.toThrow();
    expect(s.calls).toEqual([]);
  });

  it('stops at the source limit, but still lets a file of the same name be replaced', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.txt`, status: 'success' }));
    const s = setup({ kb: { bucket: 'b' }, files, embedded: ['b'] });
    await expect(s.service.addFile(ORG, { originalname: 'new.txt', size: 1, buffer: Buffer.from('x') })).rejects.toThrow(/at most 100/);
    expect(s.storage().some((c) => c.method === 'PUT')).toBe(false);
    await s.service.addFile(ORG, { originalname: 'f7.txt', size: 1, buffer: Buffer.from('x') });
    expect(s.storage().some((c) => c.method === 'PUT' && c.url.endsWith('/b/f7.txt'))).toBe(true);
  });

  it('logs sizes and timings, never the file name, its contents or the key', async () => {
    const s = setup();
    await s.service.addFile(ORG, { originalname: 'Secret fees.txt', size: 12, buffer: Buffer.from('commission 9') });
    const logged = s.lines.join('\n');
    expect(logged).toContain(ORG);
    for (const secret of [API_KEY, 'Secret fees', 'commission 9', OWN_BUCKET]) expect(logged).not.toContain(secret);
  });
});

describe('adding a website', () => {
  it('asks Telnyx to read the site into the knowledge base, then attaches it', async () => {
    const s = setup();
    await s.service.addWebsite(ORG, 'https://www.example.com');
    const post = s.calls.find((c) => c.url.endsWith('/ai/embeddings/url'))!;
    expect(post.method).toBe('POST');
    expect(JSON.parse(String(post.body))).toEqual({ url: 'https://www.example.com/', bucket_name: OWN_BUCKET });
    expect(post.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(s.assistants.setRetrieval).toHaveBeenCalledWith(ORG, OWN_BUCKET);
  });

  it('refuses a bad address before any Telnyx call', async () => {
    const s = setup();
    await expect(s.service.addWebsite(ORG, 'http://localhost/admin')).rejects.toThrow(/public website/);
    expect(s.calls).toEqual([]);
  });
});

describe('removing a source', () => {
  it('deletes a file Telnyx lists for this knowledge base, in the bucket\'s region', async () => {
    const s = setup({ kb: { bucket: 'made-in-portal' }, files: [{ filename: 'old guide.pdf', status: 'success' }] });
    await s.service.remove(ORG, 'old guide.pdf');
    const del = s.storage().find((c) => c.method === 'DELETE')!;
    expect(del.url).toBe('https://us-east-1.telnyxcloudstorage.com/made-in-portal/old%20guide.pdf');
  });

  it('never deletes a name that is not in the list, whatever the request says', async () => {
    const s = setup({ kb: { bucket: 'made-in-portal' }, files: [{ filename: 'a.txt', status: 'success' }] });
    for (const name of ['../other-bucket/a.txt', 'b.txt', '']) {
      await expect(s.service.remove(ORG, name)).rejects.toThrow(/no longer/);
    }
    expect(s.storage().filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('has nothing to delete when the assistant has no knowledge base', async () => {
    const s = setup();
    await expect(s.service.remove(ORG, 'a.txt')).rejects.toThrow(/no longer/);
    expect(s.storage()).toEqual([]);
  });
});

describe('a storage failure', () => {
  it('is reported with Telnyx\'s error code and without the key', async () => {
    const s = setup({ kb: { bucket: 'b' }, embedded: ['b'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init: any = {}) => {
        const url = String(input);
        if (url.endsWith('?location')) return new Response('<LocationConstraint>us-east-1</LocationConstraint>', { status: 200 });
        if (url.includes('telnyxcloudstorage.com') && init.method === 'PUT') {
          return new Response(`<Error><Code>AccessDenied</Code><Message>bad ${API_KEY}</Message></Error>`, { status: 403 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    const error = await s.service.addFile(ORG, { originalname: 'a.txt', size: 1, buffer: Buffer.from('x') }).catch((e) => e);
    expect(error.message).toMatch(/upload failed 403 \(AccessDenied\)/);
    expect(error.message).not.toContain(API_KEY);
  });

  it('treats the HTML page an unauthenticated request gets as a failure, not a success', async () => {
    const s = setup({ kb: { bucket: 'b' }, embedded: ['b'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        if (String(input).includes('telnyxcloudstorage.com')) return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    await expect(s.service.addFile(ORG, { originalname: 'a.txt', size: 1, buffer: Buffer.from('x') })).rejects.toThrow(/Telnyx storage/);
  });
});

function fetchOrderOf(s: ReturnType<typeof setup>, call: Call): number {
  const mock = (globalThis.fetch as any).mock;
  return mock.invocationCallOrder[s.calls.indexOf(call)];
}

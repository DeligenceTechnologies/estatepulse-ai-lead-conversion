import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { AssistantService } from './assistant.service';
import { STORAGE_DEFAULT_REGION, bucketRegion, createBucket, deleteObject, listObjects, putObject } from './knowledge-storage';
import { telnyx } from './telnyx-api';
import { TelnyxCredentialsService, type TelnyxCreds } from './telnyx-credentials.service';

/**
 * The documents and websites the AI can look answers up in: Telnyx's own
 * knowledge base. Telnyx stores the files, reads and embeds them, and searches
 * them during a conversation; EstatePulse only manages what is in there, with
 * the organization's own Telnyx account.
 *
 * A Telnyx knowledge base is a storage bucket plus a `retrieval` tool on the
 * assistant naming it. The assistant is the source of truth for which bucket is
 * the organization's: nothing about it is stored on our side, so a knowledge
 * base made in the Telnyx portal is picked up as it is.
 *
 * Every method takes the organization from its caller's credential, and the
 * bucket only from that organization's own assistant. No bucket name, file key
 * or Telnyx id is ever accepted from a request.
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCES = 100;
/** What Telnyx documents it can read as a document. Word files are not on its list. */
export const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
};

export type SourceStatus = 'processing' | 'ready' | 'failed';

export interface KnowledgeSource {
  name: string;
  kind: 'file' | 'website';
  status: SourceStatus;
  error: string | null;
}

export interface KnowledgeSourcesStatus {
  /** False until the organization has a Telnyx account and an assistant. */
  available: boolean;
  /** The assistant's knowledge base is a shared Telnyx tool, which only the Telnyx portal can change. */
  managedInTelnyx: boolean;
  sources: KnowledgeSource[];
  limits: { maxFileBytes: number; fileTypes: string[] };
}

export interface UploadedSourceFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const LIMITS = { maxFileBytes: MAX_FILE_BYTES, fileTypes: Object.keys(FILE_TYPES) };

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function sourceStatus(raw: unknown): SourceStatus {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'success' || s === 'ready' || s === 'completed') return 'ready';
  if (s.startsWith('fail') || s === 'error') return 'failed';
  return 'processing';
}

/** The name a file is stored under: its own name, with nothing that could act as a path. */
export function sourceFileName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  return base
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/^[. ]+/, '')
    .slice(-120)
    .trim();
}

/** The file's type by its extension, checked against its first bytes; the browser's Content-Type is not trusted. */
export function sourceFileType(name: string, bytes: Buffer): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const type = FILE_TYPES[ext];
  if (!type) {
    throw new AppError('VALIDATION_ERROR', 'Upload a PDF, text (.txt, .md), HTML, CSV or JSON file. Save a Word document as PDF first.');
  }
  const isPdf = bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  if (ext === 'pdf') {
    if (!isPdf) throw new AppError('VALIDATION_ERROR', 'This .pdf file is not a PDF document.');
    return type;
  }
  const binary = isPdf || bytes.subarray(0, 4).equals(ZIP_MAGIC) || bytes.subarray(0, 4096).includes(0);
  if (binary) throw new AppError('VALIDATION_ERROR', `This .${ext} file is not a text file.`);
  return type;
}

/** A public web address, as the lead's browser would open it. */
export function websiteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Enter a full website address, such as https://www.example.com');
  }
  const hostname = url.hostname.toLowerCase();
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isIp || hostname === 'localhost' || !hostname.includes('.')) {
    throw new AppError('VALIDATION_ERROR', 'Enter a public website address, such as https://www.example.com');
  }
  url.hash = '';
  return url.toString();
}

@Injectable()
export class KnowledgeSourcesService {
  private readonly logger = new Logger('KnowledgeSources');

  constructor(
    private readonly creds: TelnyxCredentialsService,
    private readonly assistants: AssistantService,
  ) {}

  async status(orgId: string): Promise<KnowledgeSourcesStatus> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.assistantId) return { available: false, managedInTelnyx: false, sources: [], limits: LIMITS };
    const kb = await this.assistants.retrieval(orgId);
    return {
      available: true,
      managedInTelnyx: Boolean(kb?.shared),
      sources: kb ? await this.sources(c.apiKey, kb.bucket) : [],
      limits: LIMITS,
    };
  }

  /** Telnyx reads the page and the pages it links to on the same site, and adds each to the knowledge base. */
  async addWebsite(orgId: string, rawUrl: string): Promise<KnowledgeSourcesStatus> {
    const url = websiteUrl(rawUrl);
    const startedAt = Date.now();
    const { c, bucket, attach } = await this.store(orgId);
    await telnyx(c.apiKey, '/ai/embeddings/url', { method: 'POST', body: JSON.stringify({ url, bucket_name: bucket }) });
    await attach();
    this.logger.log(`org ${orgId}: website queued for the knowledge base in ${Date.now() - startedAt}ms`);
    return this.status(orgId);
  }

  async addFile(orgId: string, file: UploadedSourceFile | undefined): Promise<KnowledgeSourcesStatus> {
    if (!file?.buffer?.length) throw new AppError('VALIDATION_ERROR', 'Choose a file to upload.');
    if (file.size > MAX_FILE_BYTES) {
      throw new AppError('VALIDATION_ERROR', `That file is too large. The limit is ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`);
    }
    const name = sourceFileName(file.originalname);
    if (!name) throw new AppError('VALIDATION_ERROR', 'That file has no usable name. Rename it and upload it again.');
    const contentType = sourceFileType(name, file.buffer);

    const startedAt = Date.now();
    const { c, bucket, region, attach, existing } = await this.store(orgId);
    // A file of the same name replaces the earlier one, so it does not count as another source.
    if (existing.length >= MAX_SOURCES && !existing.some((s) => s.name === name)) {
      throw new AppError('VALIDATION_ERROR', `The knowledge base holds at most ${MAX_SOURCES} sources. Remove one first.`);
    }
    await putObject(c.apiKey, region, bucket, name, file.buffer, contentType);
    // Telnyx keeps an embedded bucket level with its files by itself; a bucket
    // that has never been embedded needs the first run asked for.
    const embedded = await telnyx<{ data?: { buckets?: string[] } }>(c.apiKey, '/ai/embeddings/buckets');
    if (!embedded.data?.buckets?.includes(bucket)) {
      await telnyx(c.apiKey, '/ai/embeddings', { method: 'POST', body: JSON.stringify({ bucket_name: bucket }) });
    }
    await attach();
    this.logger.log(`org ${orgId}: document added to the knowledge base, ${file.size} bytes, ${Date.now() - startedAt}ms`);
    return this.status(orgId);
  }

  /** Removes one source. Only a name Telnyx lists for this organization's own knowledge base is acted on. */
  async remove(orgId: string, name: string): Promise<KnowledgeSourcesStatus> {
    const c = await this.requireCreds(orgId);
    const kb = await this.assistants.retrieval(orgId);
    const listed = kb ? await this.sources(c.apiKey, kb.bucket) : [];
    if (!kb || !listed.some((s) => s.name === name)) throw new AppError('NOT_FOUND', 'That source is no longer in the knowledge base.');
    await deleteObject(c.apiKey, await bucketRegion(c.apiKey, kb.bucket), kb.bucket, name);
    this.logger.log(`org ${orgId}: source removed from the knowledge base`);
    return this.status(orgId);
  }

  private async requireCreds(orgId: string): Promise<TelnyxCreds> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'Connect Telnyx first (Settings → Telnyx).');
    if (!c.assistantId) throw new AppError('CONFLICT', 'No AI assistant yet — create one in AI Settings first.');
    return c;
  }

  /**
   * The organization's knowledge base, made if there is none yet. `attach`
   * points the assistant at it and is called last, once something is in it:
   * an assistant is never left searching a bucket Telnyx has not embedded.
   * A run that fails half way is finished by the next add, since the bucket's
   * name is the same every time.
   */
  private async store(orgId: string) {
    const c = await this.requireCreds(orgId);
    const kb = await this.assistants.retrieval(orgId);
    if (kb) {
      return { c, bucket: kb.bucket, region: await bucketRegion(c.apiKey, kb.bucket), existing: await this.sources(c.apiKey, kb.bucket), attach: async () => undefined };
    }
    const bucket = `ep-kb-${orgId.replace(/-/g, '')}-${c.assistantId.replace(/[^a-z0-9]/gi, '').slice(-8)}`.toLowerCase();
    await createBucket(c.apiKey, STORAGE_DEFAULT_REGION, bucket);
    return {
      c,
      bucket,
      region: STORAGE_DEFAULT_REGION,
      existing: await this.sources(c.apiKey, bucket),
      attach: () => this.assistants.setRetrieval(orgId, bucket),
    };
  }

  /**
   * What is in the knowledge base: the bucket's own files, each with the state
   * Telnyx's reading of it is in. The files are the truth, not Telnyx's list of
   * what it has read: while Telnyx reads a new or replaced file it drops it
   * from that list for up to a minute, and a file just removed lingers in it.
   * A file Telnyx has not listed yet is shown as still being read.
   */
  private async sources(apiKey: string, bucket: string): Promise<KnowledgeSource[]> {
    const [read, files] = await Promise.all([
      this.readStates(apiKey, bucket),
      bucketRegion(apiKey, bucket)
        .then((region) => listObjects(apiKey, region, bucket))
        .catch((error) => {
          // Telnyx's own list is better than nothing while storage cannot be reached.
          this.logger.warn(`knowledge base file list unavailable — ${(error as Error).message}`);
          return null;
        }),
    ]);
    const names = files ?? [...read.keys()];
    return names
      .map((name) => {
        const r = read.get(name);
        return {
          name,
          kind: /^https?:/i.test(name) ? ('website' as const) : ('file' as const),
          status: r ? sourceStatus(r.status) : ('processing' as const),
          error: typeof r?.error_reason === 'string' && r.error_reason ? r.error_reason.slice(0, 300) : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Telnyx's reading state for each file, by name. */
  private async readStates(apiKey: string, bucket: string): Promise<Map<string, any>> {
    let rows: any[];
    try {
      rows = (await telnyx<{ data?: any[] }>(apiKey, `/ai/embeddings/buckets/${encodeURIComponent(bucket)}`)).data ?? [];
    } catch (error) {
      // A bucket Telnyx has not embedded yet has no list.
      if (/ failed 404:/.test((error as Error).message)) return new Map();
      throw error;
    }
    return new Map(rows.filter((r) => typeof r?.filename === 'string' && r.filename).map((r) => [r.filename as string, r]));
  }
}

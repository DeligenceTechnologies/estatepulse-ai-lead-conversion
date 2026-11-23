import { AppError } from '@/common/errors/app-error';

/**
 * The three Telnyx Cloud Storage calls the knowledge base needs. A Telnyx
 * knowledge base is a storage bucket that has been embedded, and Telnyx has no
 * JSON API for creating the bucket or for adding and removing a file: those go
 * to its S3-compatible endpoint. Everything else (embedding, status, website
 * crawling, retrieval) is the ordinary Telnyx API and lives in
 * KnowledgeSourcesService.
 *
 * Authentication is Telnyx's own scheme, as its storage docs give it: an AWS
 * Signature V4 shaped header whose access key id is the Telnyx API key. Telnyx
 * validates the access key id only; the date, region, service and signature
 * are ignored, so no secret key exists and none is sent. The API key rides in
 * the Authorization header, so that header is never logged and never put in an
 * error message.
 */

export const STORAGE_DEFAULT_REGION = 'us-central-1';
const TIMEOUT_MS = 30_000;

const host = (region: string) => `https://${region}.telnyxcloudstorage.com`;

/** A key or bucket name as a URL path, each segment escaped. */
const pathOf = (...segments: string[]) => '/' + segments.map((s) => s.split('/').map(encodeURIComponent).join('/')).join('/');

function headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  return {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${apiKey}/${amzDate.slice(0, 8)}/us-east-1/s3/aws4_request, ` +
      `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${'0'.repeat(64)}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    ...extra,
  };
}

interface StorageReply {
  status: number;
  ok: boolean;
  /** The S3 error code (`NoSuchBucket`, `BucketAlreadyOwnedByYou`, …), when the body carried one. */
  code: string;
  body: string;
}

async function call(apiKey: string, method: string, url: string, init: { body?: Buffer; headers?: Record<string, string> } = {}): Promise<StorageReply> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: headers(apiKey, init.headers),
      body: init.body ? new Uint8Array(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError('UPSTREAM_ERROR', `Telnyx storage unreachable: ${(error as Error).message}`);
  }
  const body = method === 'HEAD' ? '' : (await res.text()).split(apiKey).join('');
  // An unauthenticated request is answered 200 with an HTML page, not an error.
  const html = (res.headers.get('content-type') ?? '').includes('text/html');
  return { status: res.status, ok: res.ok && !html, code: body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '', body };
}

function fail(what: string, r: StorageReply): never {
  throw new AppError('UPSTREAM_ERROR', `Telnyx storage ${what} failed ${r.status}${r.code ? ` (${r.code})` : ''}`);
}

/** The region a bucket lives in. Every call but this one must go to the bucket's own region. */
export async function bucketRegion(apiKey: string, bucket: string): Promise<string> {
  const r = await call(apiKey, 'GET', `${host(STORAGE_DEFAULT_REGION)}${pathOf(bucket)}?location`);
  if (!r.ok) fail('bucket lookup', r);
  return r.body.match(/<LocationConstraint[^>]*>([^<]+)<\/LocationConstraint>/)?.[1]?.trim() || STORAGE_DEFAULT_REGION;
}

/** Creates the bucket; one this account already owns is left as it is. */
export async function createBucket(apiKey: string, region: string, bucket: string): Promise<void> {
  const r = await call(apiKey, 'PUT', `${host(region)}${pathOf(bucket)}`);
  if (r.ok || r.code === 'BucketAlreadyOwnedByYou') return;
  // Telnyx does not document what a second create answers, so ask whether the
  // bucket is ours: a HEAD succeeds only for a bucket this key can reach.
  const head = await call(apiKey, 'HEAD', `${host(region)}${pathOf(bucket)}`);
  if (head.ok) return;
  fail('bucket create', r);
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The names of the files in a bucket, up to `limit`. */
export async function listObjects(apiKey: string, region: string, bucket: string, limit = 1000): Promise<string[]> {
  const keys: string[] = [];
  let token = '';
  while (keys.length < limit) {
    const query = `?list-type=2&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const r = await call(apiKey, 'GET', `${host(region)}${pathOf(bucket)}${query}`);
    if (!r.ok) fail('file list', r);
    for (const m of r.body.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(m[1]));
    token = unescapeXml(r.body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? '');
    if (!token) break;
  }
  return keys.slice(0, limit);
}

export async function putObject(apiKey: string, region: string, bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  const r = await call(apiKey, 'PUT', `${host(region)}${pathOf(bucket, key)}`, { body, headers: { 'Content-Type': contentType } });
  if (!r.ok) fail('upload', r);
}

/** Removes a file; Telnyx drops its embeddings with it. A file already gone is not an error. */
export async function deleteObject(apiKey: string, region: string, bucket: string, key: string): Promise<void> {
  const r = await call(apiKey, 'DELETE', `${host(region)}${pathOf(bucket, key)}`);
  if (!r.ok && r.status !== 404) fail('delete', r);
}

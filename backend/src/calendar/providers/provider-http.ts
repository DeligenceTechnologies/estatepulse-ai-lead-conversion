import { Logger } from '@nestjs/common';

const REQUEST_TIMEOUT_MS = 15_000;
/** Reads are retried this many times on a rate limit, a provider hiccup or a dropped connection. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
/** Longer waits than this fail now and are left to the next sync, so a request never holds a sync for minutes. */
const MAX_RETRY_WAIT_MS = 20_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Only requests that are safe to send twice are retried (a code exchange or a refresh is single-use). */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);

const logger = new Logger('ProviderHttp');

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    /** How long the provider asked us to wait before trying again, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }

  get credentialRejected(): boolean {
    return this.status === 401;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export async function requestJson<T>(provider: string, url: string, init: RequestInit = {}): Promise<T> {
  const retryable = RETRYABLE_METHODS.has((init.method ?? 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<T>(provider, url, init);
    } catch (error) {
      if (!retryable || attempt >= MAX_RETRIES || !(error instanceof ProviderHttpError)) throw error;
      if (error.status !== 0 && !RETRYABLE_STATUSES.has(error.status)) throw error;

      const wait = error.retryAfterMs ?? backoff(attempt);
      if (wait > MAX_RETRY_WAIT_MS) throw error;
      logger.warn(`${provider} HTTP ${error.status || 'network error'}, retrying in ${Math.round(wait)}ms (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
    }
  }
}

async function requestOnce<T>(provider: string, url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ProviderHttpError(provider, 0, `${provider} could not be reached. Try again in a moment.`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderHttpError(provider, 0, `${provider} could not be reached. Try again in a moment.`);
  }

  const body = parse(text);
  if (!response.ok) {
    if (response.status === 429) {
      throw new ProviderHttpError(
        provider,
        429,
        `${provider} is limiting requests right now. It will be retried shortly.`,
        retryAfter(response.headers),
      );
    }
    const detail = errorMessage(body) ?? `request failed (${response.status})`;
    throw new ProviderHttpError(provider, response.status, `${provider}: ${detail}`, retryAfter(response.headers));
  }
  return body as T;
}

/** Exponential backoff with jitter: about 1s, 2s, 4s. */
function backoff(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  return base / 2 + Math.random() * base;
}

/**
 * The wait a provider asks for: `Retry-After` (seconds or an HTTP date), or
 * Calendly's `X-RateLimit-Reset` (seconds until the window resets).
 */
export function retryAfter(headers: Headers, now = Date.now()): number | null {
  const value = headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.has('x-ratelimit-reset') && Number.isFinite(reset)) {
    // Some APIs send an epoch timestamp here instead of seconds left.
    return Math.max(0, reset > 1e9 ? reset * 1000 - now : reset * 1000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const nested = (error as Record<string, unknown>).message;
    if (typeof nested === 'string') return nested;
  }
  for (const key of ['message', 'error_description', 'title', 'error']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

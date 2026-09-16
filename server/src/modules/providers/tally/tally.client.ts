/**
 * Thin HTTP client for api.tally.so.
 *
 * `fetch` is a constructor parameter rather than a global call. That one choice
 * is what makes every failure path below testable without a network or a Tally
 * account, which matters because the failure paths are where the money is: a
 * 5xx on install has to be reconciled rather than rolled back, and getting that
 * wrong is invisible until a customer's form silently stops delivering.
 */

import { ProviderApiError, type ProviderErrorKind } from '../types';

export type FetchLike = typeof globalThis.fetch;

/** Honouring Retry-After is the correct backstop; a token bucket would be a
 *  per-process lie across instances. Capped so a hostile header cannot hang us. */
const MAX_RETRY_AFTER_SEC = 5;

export class TallyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchLike = globalThis.fetch,
  ) {}

  async get<T>(apiKey: string, path: string, operation: string): Promise<T> {
    return this.request<T>(apiKey, 'GET', path, undefined, operation);
  }

  async post<T>(apiKey: string, path: string, body: unknown, operation: string): Promise<T> {
    return this.request<T>(apiKey, 'POST', path, body, operation);
  }

  async patch<T>(apiKey: string, path: string, body: unknown, operation: string): Promise<T> {
    return this.request<T>(apiKey, 'PATCH', path, body, operation);
  }

  /** Resolves `true` when it deleted, `false` when it was already gone. */
  async delete(apiKey: string, path: string, operation: string): Promise<boolean> {
    try {
      await this.request<unknown>(apiKey, 'DELETE', path, undefined, operation);
      return true;
    } catch (e) {
      // Already absent is the outcome the caller wanted. Treating 404 as an
      // error would make disconnect fail for the one case where there is
      // nothing left to do.
      if (e instanceof ProviderApiError && e.kind === 'NOT_FOUND') return false;
      throw e;
    }
  }

  private async request<T>(
    apiKey: string,
    method: string,
    path: string,
    body: unknown,
    operation: string,
    isRetry = false,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Timeout, DNS, socket reset. For a POST this is precisely the
      // "might have executed" case — see ProviderApiError.mayHaveExecuted.
      throw new ProviderApiError(
        'PROVIDER_UNAVAILABLE',
        'TALLY',
        operation,
        `Could not reach Tally (${e instanceof Error ? e.name : 'network error'}).`,
      );
    }

    if (res.status === 429 && !isRetry) {
      // `|| 1` would be wrong here: Retry-After: 0 is a valid instruction to
      // retry immediately, and 0 is falsy.
      const raw = res.headers.get('retry-after');
      const parsed = raw === null ? 1 : Number(raw);
      const wait = Math.min(Number.isFinite(parsed) && parsed >= 0 ? parsed : 1, MAX_RETRY_AFTER_SEC);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request<T>(apiKey, method, path, body, operation, true);
    }

    if (!res.ok) throw await this.toError(res, operation, apiKey);

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 2xx we cannot read is not a success we can act on.
      throw new ProviderApiError(
        'UNEXPECTED_RESPONSE',
        'TALLY',
        operation,
        'Tally returned a response we could not parse.',
        res.status,
      );
    }
  }

  private async toError(res: Response, operation: string, apiKey: string): Promise<ProviderApiError> {
    const kind: ProviderErrorKind =
      res.status === 401
        ? 'INVALID_CREDENTIAL'
        : res.status === 403
          ? 'FORBIDDEN'
          : res.status === 404
            ? 'NOT_FOUND'
            : res.status === 429
              ? 'RATE_LIMITED'
              : res.status >= 500
                ? 'PROVIDER_UNAVAILABLE'
                : 'INVALID_REQUEST';

    // Tally's own wording, truncated and REDACTED.
    //
    // Never assume an upstream error body is safe to repeat: gateways and debug
    // handlers routinely echo the Authorization header back, and this string
    // ends up in logs and in an HTTP response to the browser — both of which
    // outlive the request. Redacting the key we just sent is exact; the pattern
    // catches any other Tally-shaped token that shows up beside it.
    let detail = '';
    try {
      detail = redact((await res.text()).slice(0, 200), apiKey);
    } catch {
      /* body already consumed or unreadable */
    }

    const retryAfter = res.headers.get('retry-after');

    return new ProviderApiError(
      kind,
      'TALLY',
      operation,
      MESSAGES[kind] + (detail ? ` (${detail})` : ''),
      res.status,
      retryAfter ? Number(retryAfter) || undefined : undefined,
    );
  }
}

/** Strip the credential we sent, plus anything else shaped like a Tally key. */
function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return withoutKey.replace(/tly-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/**
 * Written for the person reading them in our UI, who is not a Tally engineer.
 * Each says what happened and what to do, and never blames our own server for a
 * third party being down.
 */
const MESSAGES: Record<ProviderErrorKind, string> = {
  INVALID_CREDENTIAL: 'Tally rejected the API key. It may have been revoked, or copied incompletely.',
  FORBIDDEN: 'That Tally key is valid but not allowed to do this.',
  NOT_FOUND: 'Tally could not find that form or webhook.',
  INVALID_REQUEST: 'Tally rejected the request.',
  RATE_LIMITED: 'Tally is rate-limiting us. Nothing was created; try again shortly.',
  PROVIDER_UNAVAILABLE: 'Tally is not responding. Our side is fine — nothing was created.',
  UNEXPECTED_RESPONSE: 'Tally returned something unexpected.',
};

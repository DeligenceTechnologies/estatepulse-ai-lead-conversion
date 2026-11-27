/**
 * HTTP client for Jotform's API. The retry, timeout and error mapping are
 * ProviderHttpClient's; what is Jotform-specific lives here:
 *
 *   - The key travels in an `APIKEY` header, and POST bodies are form-encoded.
 *   - Every response is wrapped as `{ responseCode, message, content }`, and the
 *     envelope's code can report an error on an HTTP 200. That case is an error
 *     here too, never a success with empty content.
 *   - Accounts live in a region. A key from an EU account is rejected by
 *     api.jotform.com and accepted by eu-api.jotform.com, so a 401 from one
 *     region is retried on the other before the key is called invalid. The
 *     region that answered is remembered per key for this process.
 */

import { createHash } from 'node:crypto';
import { ProviderHttpClient, type FetchLike } from '../provider-http';
import { ProviderApiError, type ProviderErrorKind } from '../types';

export type { FetchLike };

interface JotformEnvelope<T> {
  responseCode?: number;
  message?: string;
  content?: T;
}

const SPEC = {
  provider: 'JOTFORM',
  displayName: 'Jotform',
  // Jotform keys are 32 hex characters.
  tokenPattern: /\b[a-f0-9]{32}\b/g,
  authHeaders: (apiKey: string) => ({ APIKEY: apiKey }),
  bodyEncoding: 'form' as const,
};

export class JotformClient {
  private readonly regions: ProviderHttpClient[];
  /** sha256(key) → index into `regions` that last accepted it. */
  private readonly regionByKey = new Map<string, number>();

  constructor(baseUrls: string[], timeoutMs: number, fetchFn: FetchLike = globalThis.fetch) {
    this.regions = baseUrls.filter(Boolean).map((url) => new ProviderHttpClient(SPEC, url.replace(/\/+$/, ''), timeoutMs, fetchFn));
  }

  get<T>(apiKey: string, path: string, operation: string): Promise<T> {
    return this.inRegion(apiKey, async (http) => this.unwrap(await http.get<JotformEnvelope<T>>(apiKey, path, operation), operation, apiKey));
  }

  post<T>(apiKey: string, path: string, body: Record<string, string>, operation: string): Promise<T> {
    return this.inRegion(apiKey, async (http) =>
      this.unwrap(await http.post<JotformEnvelope<T>>(apiKey, path, body, operation), operation, apiKey),
    );
  }

  /** Resolves `true` when it deleted, `false` when it was already gone. */
  delete(apiKey: string, path: string, operation: string): Promise<boolean> {
    return this.inRegion(apiKey, (http) => http.delete(apiKey, path, operation));
  }

  /**
   * Runs one request in the key's region: the one that last accepted it, or
   * each region in turn until one does. Only a rejected key moves on to the
   * next region; any other failure is final.
   */
  private async inRegion<R>(apiKey: string, run: (http: ProviderHttpClient) => Promise<R>): Promise<R> {
    const keyId = createHash('sha256').update(apiKey).digest('hex');
    const known = this.regionByKey.get(keyId);
    const order = known === undefined ? this.regions.map((_, i) => i) : [known];

    let lastError: unknown;
    for (const i of order) {
      try {
        const result = await run(this.regions[i]);
        this.regionByKey.set(keyId, i);
        return result;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProviderApiError && error.kind === 'INVALID_CREDENTIAL')) throw this.explain(error);
      }
    }
    throw lastError;
  }

  /**
   * Jotform creates keys read-only unless the owner picks otherwise. Such a key
   * lists forms fine and then fails the webhook install with a bare "You are
   * not allowed", so a 403 here is almost always that, and says how to fix it.
   */
  private explain(error: unknown): unknown {
    if (!(error instanceof ProviderApiError) || error.kind !== 'FORBIDDEN') return error;
    return new ProviderApiError(
      'FORBIDDEN',
      'JOTFORM',
      error.operation,
      'This Jotform API key is read-only. In Jotform → Settings → API, change its permission to Full Access, then try again.',
      error.status,
    );
  }

  private unwrap<T>(envelope: JotformEnvelope<T> | undefined, operation: string, apiKey: string): T {
    const code = envelope?.responseCode;
    if (code !== undefined && (code < 200 || code >= 300)) {
      const kind: ProviderErrorKind =
        code === 401
          ? 'INVALID_CREDENTIAL'
          : code === 403
            ? 'FORBIDDEN'
            : code === 404
              ? 'NOT_FOUND'
              : code === 429
                ? 'RATE_LIMITED'
                : code >= 500
                  ? 'PROVIDER_UNAVAILABLE'
                  : 'INVALID_REQUEST';
      const detail = (envelope?.message ?? '').split(apiKey).join('[redacted]').slice(0, 200);
      throw new ProviderApiError(kind, 'JOTFORM', operation, `Jotform refused the request${detail ? ` (${detail})` : ''}.`, code);
    }
    return envelope?.content as T;
  }
}

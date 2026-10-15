/**
 * Thin HTTP client for api.typeform.com. All the behaviour lives in
 * ProviderHttpClient; this only names the provider and the shape of its tokens.
 *
 * Typeform rate-limits personal tokens at 2 requests a second; the shared 429
 * handling (one retry, honouring Retry-After) is enough for a connect flow.
 */

import { ProviderHttpClient, type FetchLike } from '../provider-http';

export type { FetchLike };

export class TypeformClient extends ProviderHttpClient {
  constructor(baseUrl: string, timeoutMs: number, fetchFn: FetchLike = globalThis.fetch) {
    super(
      { provider: 'TYPEFORM', displayName: 'Typeform', tokenPattern: /tfp_[A-Za-z0-9_-]{8,}/g },
      baseUrl,
      timeoutMs,
      fetchFn,
    );
  }
}

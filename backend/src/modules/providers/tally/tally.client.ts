/**
 * Thin HTTP client for api.tally.so. All the behaviour lives in
 * ProviderHttpClient; this only names the provider and the shape of its keys.
 */

import { ProviderHttpClient, type FetchLike } from '../provider-http';

export type { FetchLike };

export class TallyClient extends ProviderHttpClient {
  constructor(baseUrl: string, timeoutMs: number, fetchFn: FetchLike = globalThis.fetch) {
    super(
      { provider: 'TALLY', displayName: 'Tally', tokenPattern: /tly-[A-Za-z0-9_-]{8,}/g },
      baseUrl,
      timeoutMs,
      fetchFn,
    );
  }
}

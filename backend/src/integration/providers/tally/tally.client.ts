import { ProviderApiError, type ProviderErrorKind } from '../types';

export type FetchLike = typeof globalThis.fetch;

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

  async delete(apiKey: string, path: string, operation: string): Promise<boolean> {
    try {
      await this.request<unknown>(apiKey, 'DELETE', path, undefined, operation);
      return true;
    } catch (e) {
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
      throw new ProviderApiError(
        'PROVIDER_UNAVAILABLE',
        'TALLY',
        operation,
        `Could not reach Tally (${e instanceof Error ? e.name : 'network error'}).`,
      );
    }

    if (res.status === 429 && !isRetry) {
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

    let detail = '';
    try {
      detail = redact((await res.text()).slice(0, 200), apiKey);
    } catch {
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

function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return withoutKey.replace(/tly-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

const MESSAGES: Record<ProviderErrorKind, string> = {
  INVALID_CREDENTIAL: 'Tally rejected the API key. It may have been revoked, or copied incompletely.',
  FORBIDDEN: 'That Tally key is valid but not allowed to do this.',
  NOT_FOUND: 'Tally could not find that form or webhook.',
  INVALID_REQUEST: 'Tally rejected the request.',
  RATE_LIMITED: 'Tally is rate-limiting us. Nothing was created; try again shortly.',
  PROVIDER_UNAVAILABLE: 'Tally is not responding. Our side is fine — nothing was created.',
  UNEXPECTED_RESPONSE: 'Tally returned something unexpected.',
};

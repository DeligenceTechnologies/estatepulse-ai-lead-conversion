import { AppError } from '@/common/errors/app-error';

export const TELNYX_API = 'https://api.telnyx.com/v2';

/** Telnyx refused the API key itself (revoked or deleted). A 403 is left out: it also means "not allowed to text that number". */
export const isTelnyxKeyRejected = (error: unknown): boolean =>
  error instanceof Error && /^Telnyx \S+ \S+ failed 401:/.test(error.message);

/** A Telnyx call that throws an UPSTREAM_ERROR with the provider's own message on failure. */
export async function telnyx<T = any>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${TELNYX_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError('UPSTREAM_ERROR', `Telnyx unreachable: ${(error as Error).message}`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new AppError('UPSTREAM_ERROR', `Telnyx ${init.method ?? 'GET'} ${path.split('?')[0]} failed ${res.status}: ${detail}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

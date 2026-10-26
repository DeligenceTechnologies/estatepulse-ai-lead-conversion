import { AppError } from '@/common/errors/app-error';

export const RETELL_API = 'https://api.retellai.com';

/**
 * A Retell call that throws an UPSTREAM_ERROR with the provider's own message
 * on failure, worded like telnyx() so the call worker reads a 429 alike.
 */
export async function retell<T = any>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RETELL_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError('UPSTREAM_ERROR', `Retell unreachable: ${(error as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text();
    // Retell answers { status: "error", message }; its message is what the owner needs to read.
    let detail = text;
    try {
      detail = (JSON.parse(text) as { message?: unknown }).message?.toString() || text;
    } catch {
      // not JSON: keep the raw text
    }
    throw new AppError('UPSTREAM_ERROR', `Retell ${init.method ?? 'GET'} ${path.split('?')[0]} failed ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

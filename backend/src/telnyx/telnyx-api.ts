import { AppError } from '@/common/errors/app-error';

export const TELNYX_API = 'https://api.telnyx.com/v2';

/** Telnyx refused the API key itself (revoked or deleted). A 403 is left out: it also means "not allowed to text that number". */
export const isTelnyxKeyRejected = (error: unknown): boolean =>
  error instanceof Error && /^Telnyx \S+ \S+ failed 401:/.test(error.message);

/**
 * Telnyx's error body as one readable line: `{ errors: [{ code, title, detail }] }` becomes
 * "Invalid 'to' address — The 'to' address should be a single valid number. (40310)". These
 * messages end up on the lead's timeline and in the UI, so no raw JSON.
 */
export function telnyxErrorText(body: string): string {
  const text = body.trim();
  try {
    const parsed = JSON.parse(text) as { errors?: { code?: string; title?: string; detail?: string }[] };
    const lines = (parsed.errors ?? [])
      .map((e) => [e.title, e.detail].filter(Boolean).join(' — ') + (e.code ? ` (${e.code})` : ''))
      .filter((l) => l.trim() && l.trim() !== `(${''})`);
    if (lines.length) return lines.join('; ').slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 300) || `no details (HTTP body empty)`;
}

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
    throw new AppError('UPSTREAM_ERROR', `Telnyx ${init.method ?? 'GET'} ${path.split('?')[0]} failed ${res.status}: ${telnyxErrorText(await res.text())}`);
  }
  // Some writes (adding a message to a conversation) answer 200 with no body.
  const body = res.status === 204 ? '' : await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

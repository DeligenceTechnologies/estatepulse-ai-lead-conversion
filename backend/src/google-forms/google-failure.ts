import { HttpException } from '@nestjs/common';

export interface GoogleFailure {
  code: string;
  message: string;
}

/**
 * Why a read of a form failed, in the words written for the owner.
 *
 * The Google connection reports its failures as an HttpException built by
 * `httpError`, whose code and message sit in the response body. The
 * exception's own `.message` is Nest's generic "Http Exception", which is what
 * an owner was shown when their Google access had simply expired.
 */
export function googleFailure(error: unknown, fallbackCode = 'POLL_FAILED'): GoogleFailure {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const inner = typeof body === 'object' && body !== null ? (body as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    const code = typeof inner?.code === 'string' && inner.code ? inner.code : fallbackCode;
    if (typeof inner?.message === 'string' && inner.message) return { code, message: inner.message };
    return { code, message: typeof body === 'string' && body ? body : error.message };
  }
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === 'string' && code ? code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

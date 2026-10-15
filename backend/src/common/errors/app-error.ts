import { HttpException } from '@nestjs/common';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_ERROR: 502,
};

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * An error the client may branch on. The body is `{ error: { code, message } }`,
 * which the frontend decodes alongside Nest's own `{ statusCode, message }`.
 */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode | string,
    message: string,
    readonly details?: ErrorDetail[],
    status?: number,
  ) {
    super(
      { error: { code, message, ...(details?.length ? { details } : {}) } },
      status ?? STATUS[code as ErrorCode] ?? 400,
    );
    this.message = message;
  }
}

/** An `{ error: { code, message } }` response with an explicit status and a provider-specific code. */
export function httpError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpException({ error: { code, message, ...extra } }, status);
}

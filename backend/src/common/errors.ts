import { z } from 'zod';

/**
 * The API's error vocabulary. Every failure the client is meant to branch on
 * has a code here; anything else is INTERNAL and says nothing more.
 *
 * The frontend decodes `error.code` (see frontend/src/lib/api.ts), so these
 * strings are part of the contract — renaming one is a breaking change.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'EMAIL_TAKEN'
  | 'NO_ORGANIZATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  NO_ORGANIZATION: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
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
 * An error the client is allowed to see. Anything thrown that is NOT an
 * AppError (or a Nest HttpException) is treated as a bug: logged in full,
 * reported as INTERNAL, and never echoed back.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export const zodDetails = (error: z.ZodError): ErrorDetail[] =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'EMAIL_TAKEN'
  | 'NO_ORGANIZATION'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  NO_ORGANIZATION: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export interface ErrorDetail {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const zodDetails = (error: z.ZodError): ErrorDetail[] =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
}

/**
 * Terminal error handler. Known AppErrors surface their code; everything else
 * is logged in full and answered with a generic INTERNAL, so stack traces and
 * driver messages never reach a client.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  // express.json() rejects malformed bodies and oversized payloads with a
  // SyntaxError / entity.too.large carrying a 4xx status.
  if (err instanceof SyntaxError && 'status' in err && typeof err.status === 'number' && err.status < 500) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    return;
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body too large' } });
    return;
  }

  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

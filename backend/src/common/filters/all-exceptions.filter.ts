import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, ERROR_STATUS, type ErrorCode, type ErrorDetail } from '../errors';

interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetail[] };
}

/**
 * The single place an exception becomes a response body.
 *
 * Every route answers with the same envelope — `{ error: { code, message } }` —
 * because the frontend branches on `error.code` and a second shape would mean a
 * second decoder and a class of bugs that only appear on failure paths.
 *
 * The other half of its job is to not leak. An unrecognised throw is a bug, and
 * bugs carry stack traces, SQL fragments and sometimes credentials, so only
 * AppError and HttpException are trusted to describe themselves. Everything
 * else is logged in full and answered with a bare INTERNAL.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // A stream that already started cannot be rewritten into an envelope.
    if (res.headersSent) return;

    const { status, body, logAsError } = this.translate(exception);

    if (logAsError) {
      this.logger.error(`${req.method} ${req.originalUrl} -> ${status} ${body.error.code}`, exception as Error);
    }

    res.status(status).json(body);
  }

  private translate(exception: unknown): { status: number; body: ErrorBody; logAsError: boolean } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
          },
        },
        logAsError: exception.status >= 500,
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    // The body parser rejects malformed JSON and oversized payloads with a
    // 4xx-carrying SyntaxError / entity.too.large rather than an HttpException.
    const asBodyParserError = this.fromBodyParserError(exception);
    if (asBodyParserError) return asBodyParserError;

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL', message: 'Internal server error' } },
      logAsError: true,
    };
  }

  /**
   * Nest's own exceptions carry either a plain message or an arbitrary object.
   * A thrower that already supplied our envelope keeps it; a bare
   * `NotFoundException('...')` is mapped onto the nearest code.
   */
  private fromHttpException(exception: HttpException): {
    status: number;
    body: ErrorBody;
    logAsError: boolean;
  } {
    const status = exception.getStatus();
    const response = exception.getResponse();

    if (typeof response === 'object' && response !== null && 'error' in response) {
      const envelope = (response as { error?: { code?: string; message?: string; details?: ErrorDetail[] } }).error;
      if (envelope?.code) {
        return {
          status,
          body: {
            error: {
              code: envelope.code as ErrorCode,
              message: envelope.message ?? exception.message,
              ...(envelope.details ? { details: envelope.details } : {}),
            },
          },
          logAsError: status >= 500,
        };
      }
    }

    // class-validator / ValidationPipe put their messages in `message`.
    const details =
      typeof response === 'object' && response !== null && Array.isArray((response as { message?: unknown }).message)
        ? ((response as { message: string[] }).message.map((m) => ({ path: '', message: m })) as ErrorDetail[])
        : undefined;

    return {
      status,
      body: {
        error: {
          code: this.codeForStatus(status),
          message: details?.length ? 'Request validation failed' : exception.message,
          ...(details ? { details } : {}),
        },
      },
      logAsError: status >= 500,
    };
  }

  private fromBodyParserError(
    exception: unknown,
  ): { status: number; body: ErrorBody; logAsError: boolean } | null {
    if (typeof exception !== 'object' || exception === null) return null;
    const err = exception as { type?: string; status?: number };

    if (err.type === 'entity.too.large') {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Request body too large' } },
        logAsError: false,
      };
    }
    if (exception instanceof SyntaxError && typeof err.status === 'number' && err.status < 500) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } },
        logAsError: false,
      };
    }
    return null;
  }

  private codeForStatus(status: number): ErrorCode {
    const match = (Object.entries(ERROR_STATUS) as [ErrorCode, number][]).find(
      ([code, s]) => s === status && code !== 'INVALID_CREDENTIALS' && code !== 'TOKEN_EXPIRED' && code !== 'EMAIL_TAKEN',
    );
    return match?.[0] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_ERROR');
  }
}

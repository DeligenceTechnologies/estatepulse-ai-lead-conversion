import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { AppError } from '../errors';

/**
 * Turns a failed third-party call into a 502 that says what the provider said.
 *
 * These handlers are thin wrappers over Telnyx's API, so most failures are not
 * our bug — they are an expired key, a number that cannot be bought, a model
 * that is not enabled on the account. Reporting those as 500 INTERNAL would
 * hide the one piece of information that lets the user fix it, so the provider's
 * message is passed through under UPSTREAM_ERROR.
 *
 * AppError and HttpException pass untouched: those were raised deliberately and
 * already carry the right code.
 */
@Injectable()
export class UpstreamErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof AppError || err instanceof HttpException) {
          return throwError(() => err);
        }
        const message = err instanceof Error ? err.message : 'Request failed';
        return throwError(() => new AppError('UPSTREAM_ERROR', message));
      }),
    );
  }
}

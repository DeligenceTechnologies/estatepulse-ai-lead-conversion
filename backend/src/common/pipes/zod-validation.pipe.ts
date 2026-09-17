import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError, zodDetails } from '../errors';

/**
 * Validates a payload against a zod schema and returns the PARSED value, so
 * handlers receive the schema's output type — trimmed, lower-cased, coerced —
 * rather than whatever arrived on the wire.
 *
 * zod rather than class-validator because the schemas predate the port and are
 * the source of truth for these shapes (see auth/schemas.ts). Mixing both would
 * mean two places to look when a field is rejected.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly message = 'Request validation failed',
  ) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', this.message, zodDetails(parsed.error));
    }
    return parsed.data;
  }
}

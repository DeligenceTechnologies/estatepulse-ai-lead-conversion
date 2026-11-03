import { describe, expect, it } from 'vitest';
import { AppError } from '@/common/errors/app-error';
import { isTransientTelnyxError } from './in-call-booking-settings.service';

describe('isTransientTelnyxError', () => {
  const upstream = (m: string) => new AppError('UPSTREAM_ERROR', m);
  it('retries Telnyx being unreachable, rate-limited or failing on its side', () => {
    expect(isTransientTelnyxError(upstream('Telnyx unreachable: The operation was aborted due to timeout'))).toBe(true);
    expect(isTransientTelnyxError(upstream('Telnyx POST /ai/tools failed 503: Service Unavailable'))).toBe(true);
    expect(isTransientTelnyxError(upstream('Telnyx PUT /ai/assistants/a/tools/t failed 429: too many requests'))).toBe(true);
  });
  it('does not retry a request Telnyx rejected', () => {
    expect(isTransientTelnyxError(upstream('Telnyx POST /integration_secrets failed 422: identifier already exists'))).toBe(false);
    expect(isTransientTelnyxError(new AppError('CONFLICT', 'Connect Calendly first.'))).toBe(false);
    expect(isTransientTelnyxError(new Error('boom'))).toBe(false);
  });
});

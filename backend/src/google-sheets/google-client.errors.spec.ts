import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleApiError, GoogleClient } from './google.client';

/**
 * A 403 means two very different things, and only one of them is the owner's to
 * fix. Google says which in `details[].reason` on the newer APIs (Forms) and in
 * `errors[].reason` on the older ones (Drive, Sheets), so both are read.
 */
const client = new GoogleClient({ get: () => undefined } as never);

const respond = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }) as never);

const kindOf = async (): Promise<string> => {
  try {
    await client.form('token', 'form-id');
  } catch (error) {
    return error instanceof GoogleApiError ? error.kind : `not-a-GoogleApiError:${String(error)}`;
  }
  return 'no-error';
};

describe('GoogleClient 403 classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads SERVICE_DISABLED out of details[] (Forms API shape)', async () => {
    respond(403, {
      error: {
        code: 403,
        message: 'Google Forms API has not been used in project 1 before or it is disabled.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }],
      },
    });
    expect(await kindOf()).toBe('API_DISABLED');
  });

  it('reads SERVICE_DISABLED out of errors[] (classic Drive shape)', async () => {
    respond(403, { error: { message: 'disabled', errors: [{ reason: 'SERVICE_DISABLED' }] } });
    expect(await kindOf()).toBe('API_DISABLED');
  });

  it('keeps a per-file 403 as DENIED, which the owner can fix by re-picking', async () => {
    respond(403, {
      error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' },
    });
    expect(await kindOf()).toBe('DENIED');
  });

  it('still rate-limits on a 403 that says so', async () => {
    respond(403, { error: { message: 'slow down', errors: [{ reason: 'userRateLimitExceeded' }] } });
    expect(await kindOf()).toBe('RATE_LIMITED');
  });

  it('leaves the other statuses alone', async () => {
    respond(404, { error: { message: 'gone' } });
    expect(await kindOf()).toBe('NOT_FOUND');
  });
});

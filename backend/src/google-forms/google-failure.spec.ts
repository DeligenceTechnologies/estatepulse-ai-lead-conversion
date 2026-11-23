import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { httpError } from '@/common/errors/app-error';
import { googleFailure } from './google-failure';

describe('why a read of a Google form failed', () => {
  it('gives the owner the reconnect message, not "Http Exception", when Google access has expired', () => {
    const error = httpError(409, 'GOOGLE_REAUTH_REQUIRED', 'Google access was revoked or has expired. Reconnect Google to continue.');
    // What used to be stored and shown on the form's card.
    expect((error as Error).message).toBe('Http Exception');
    expect(googleFailure(error)).toEqual({
      code: 'GOOGLE_REAUTH_REQUIRED',
      message: 'Google access was revoked or has expired. Reconnect Google to continue.',
    });
  });

  it('keeps the text of an exception that carries only a string', () => {
    expect(googleFailure(new HttpException('Form not found', 404))).toEqual({ code: 'POLL_FAILED', message: 'Form not found' });
  });

  it('keeps the code and message of any other error', () => {
    expect(googleFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toEqual({ code: 'ECONNRESET', message: 'socket hang up' });
    expect(googleFailure(new Error('boom'))).toEqual({ code: 'POLL_FAILED', message: 'boom' });
    expect(googleFailure('nope')).toEqual({ code: 'POLL_FAILED', message: 'nope' });
  });
});

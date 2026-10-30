import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { ApiError, apiFetch: vi.fn(), messageFor: () => 'Something went wrong on our end. Please try again.' };
});

import { ApiError } from '../lib/api';
import { retellMessage } from './retellApi';

describe('retellMessage', () => {
  it('shows Retell’s own reason when Retell refused the request', () => {
    const e = new (ApiError as any)('UPSTREAM_ERROR', 'Retell POST /create-agent failed 400: Voice xai-Iris is only supported with xai speech-to-speech models.', 502);
    expect(retellMessage(e)).toBe('Retell: Voice xai-Iris is only supported with xai speech-to-speech models.');
  });

  it('keeps the usual wording for everything else', () => {
    expect(retellMessage(new (ApiError as any)('INTERNAL', 'boom', 500))).toBe('Something went wrong on our end. Please try again.');
    expect(retellMessage(new Error('x'))).toBe('Something went wrong on our end. Please try again.');
  });
});

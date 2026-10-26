import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', async () => {
  class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { ApiError, apiFetch: vi.fn(), getToken: vi.fn() };
});

import { ApiError, apiFetch, getToken } from '../lib/api';
import { getCallingProvider, getSwitchPreview, switchCallingProvider } from './callingProviderApi';

const mockFetch = vi.mocked(apiFetch);
let session = 0;
// A new session per test: the answer is cached per session token.
beforeEach(() => {
  mockFetch.mockClear();
  session += 1;
  vi.mocked(getToken).mockReturnValue(`token-${session}`);
});

describe('getCallingProvider', () => {
  it('Retell switched off on the server (404): Telnyx with SMS, and nothing Retell shows', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new (ApiError as any)('RETELL_DISABLED', 'off', 404)));
    expect(await getCallingProvider()).toEqual({ enabled: false, provider: 'telnyx', capabilities: { sms: true } });
    await getCallingProvider();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('Retell switched on: the organization’s provider and what it can send', async () => {
    mockFetch.mockImplementation(async () => ({ provider: 'retell', capabilities: { sms: false } }));
    expect(await getCallingProvider()).toEqual({ enabled: true, provider: 'retell', capabilities: { sms: false } });
  });

  it('asks again after signing in to another organization', async () => {
    mockFetch.mockImplementation(async () => ({ provider: 'retell', capabilities: { sms: false } }));
    await getCallingProvider();
    vi.mocked(getToken).mockReturnValue('another-org');
    mockFetch.mockImplementation(async () => ({ provider: 'telnyx', capabilities: { sms: true } }));
    expect((await getCallingProvider()).provider).toBe('telnyx');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('a transient failure falls back to Telnyx and is asked again next time', async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    mockFetch.mockImplementationOnce(async () => ({ provider: 'retell', capabilities: { sms: false } }));
    expect((await getCallingProvider()).provider).toBe('telnyx');
    expect((await getCallingProvider()).provider).toBe('retell');
  });

  it('a switch updates every screen’s answer without asking the server again', async () => {
    mockFetch.mockImplementation(async () => ({ provider: 'telnyx', capabilities: { sms: true } }));
    await getCallingProvider();
    await switchCallingProvider('retell');
    expect(mockFetch).toHaveBeenLastCalledWith('/calling-provider', { method: 'PUT', body: { provider: 'retell' }, auth: true });
    expect(await getCallingProvider()).toEqual({ enabled: true, provider: 'retell', capabilities: { sms: false } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('asks for the switch preview by provider', async () => {
    mockFetch.mockImplementation(async () => ({}));
    await getSwitchPreview('telnyx');
    expect(mockFetch).toHaveBeenCalledWith('/calling-provider/switch-preview?provider=telnyx', { auth: true });
  });
});

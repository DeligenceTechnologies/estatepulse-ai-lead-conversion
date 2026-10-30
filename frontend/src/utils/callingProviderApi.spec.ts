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
import { SMS_READY, getCallingProvider, getSwitchPreview, smsDisabledReasonOf, switchCallingProvider } from './callingProviderApi';

const NOT_SET_UP = { available: false, state: 'not_configured', reason: 'SMS is not set up on Retell yet.', deliveryReports: false } as const;

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
    expect(await getCallingProvider()).toEqual({ enabled: false, provider: 'telnyx', capabilities: { sms: true }, sms: SMS_READY });
    await getCallingProvider();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('Retell switched on: the organization’s provider and whether it can text right now, with the reason', async () => {
    mockFetch.mockImplementation(async () => ({ provider: 'retell', capabilities: { sms: true }, sms: NOT_SET_UP }));
    const state = await getCallingProvider();
    expect(state).toEqual({ enabled: true, provider: 'retell', capabilities: { sms: true }, sms: NOT_SET_UP });
    expect(smsDisabledReasonOf(state)).toBe('SMS is not set up on Retell yet.');
    expect(smsDisabledReasonOf({ ...state, sms: { ...SMS_READY, state: 'unverified', reason: 'A2P not verified' } })).toBeUndefined();
    expect(smsDisabledReasonOf(null)).toBeUndefined();
  });

  it('asks again after signing in to another organization', async () => {
    mockFetch.mockImplementation(async () => ({ provider: 'retell', capabilities: { sms: true }, sms: NOT_SET_UP }));
    await getCallingProvider();
    vi.mocked(getToken).mockReturnValue('another-org');
    mockFetch.mockImplementation(async () => ({ provider: 'telnyx', capabilities: { sms: true } }));
    expect((await getCallingProvider()).provider).toBe('telnyx');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('a transient failure falls back to Telnyx and is asked again next time', async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    mockFetch.mockImplementationOnce(async () => ({ provider: 'retell', capabilities: { sms: true }, sms: NOT_SET_UP }));
    expect((await getCallingProvider()).provider).toBe('telnyx');
    expect((await getCallingProvider()).provider).toBe('retell');
  });

  it('a switch makes every screen ask the server again, since only it knows what the new provider can send', async () => {
    mockFetch.mockImplementation(async () => ({ provider: 'telnyx', capabilities: { sms: true }, sms: SMS_READY }));
    await getCallingProvider();
    mockFetch.mockImplementationOnce(async () => ({ from: 'telnyx', to: 'retell', liveCalls: 0, blockers: [], warnings: [] }));
    await switchCallingProvider('retell');
    expect(mockFetch).toHaveBeenCalledWith('/calling-provider', { method: 'PUT', body: { provider: 'retell' }, auth: true });
    mockFetch.mockImplementation(async () => ({ provider: 'retell', capabilities: { sms: true }, sms: NOT_SET_UP }));
    expect(await getCallingProvider()).toEqual({ enabled: true, provider: 'retell', capabilities: { sms: true }, sms: NOT_SET_UP });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('asks for the switch preview by provider', async () => {
    mockFetch.mockImplementation(async () => ({}));
    await getSwitchPreview('telnyx');
    expect(mockFetch).toHaveBeenCalledWith('/calling-provider/switch-preview?provider=telnyx', { auth: true });
  });
});

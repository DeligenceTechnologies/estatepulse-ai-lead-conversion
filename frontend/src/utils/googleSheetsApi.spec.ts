import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../lib/api';
import { connectGoogle } from './googleSheetsApi';

const ORIGIN = 'http://localhost:3000';
const SOURCE = 'estatepulse:google-oauth';
const mockFetch = vi.mocked(apiFetch);

let listeners: Set<(e: { origin: string; data: unknown }) => void>;
let popup: { location: { href: string }; close: ReturnType<typeof vi.fn> } | null;

const emit = (origin: string, data: unknown) => listeners.forEach((fn) => fn({ origin, data }));
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listeners = new Set();
  popup = { location: { href: '' }, close: vi.fn() };
  vi.stubGlobal('window', {
    open: vi.fn(() => popup),
    location: { origin: ORIGIN },
    addEventListener: (_t: string, fn: (e: { origin: string; data: unknown }) => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: (e: { origin: string; data: unknown }) => void) => listeners.delete(fn),
    BroadcastChannel,
  });
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string) =>
    path.endsWith('/oauth/start')
      ? { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 'STATE-1' }
      : { id: 'conn-1', accountEmail: 'owner@example.test', status: 'ACTIVE' },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('connectGoogle', () => {
  it('completes only with the callback for its own state, from its own origin', async () => {
    const done = connectGoogle();
    await tick();
    expect(popup!.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');

    emit('https://evil.example', { source: SOURCE, code: 'EVIL', state: 'STATE-1' });
    emit(ORIGIN, { source: SOURCE, code: 'OTHER-TAB', state: 'STATE-2' });
    emit(ORIGIN, { source: 'something-else', code: 'NOPE', state: 'STATE-1' });
    emit(ORIGIN, { source: SOURCE, code: 'GOOD', state: 'STATE-1', error: null });

    await expect(done).resolves.toMatchObject({ id: 'conn-1' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith('/integrations/google-sheets/oauth/complete', {
      method: 'POST',
      auth: true,
      body: { code: 'GOOD', state: 'STATE-1' },
    });
  });

  it('still completes when Google severed the opener, through the BroadcastChannel', async () => {
    const done = connectGoogle();
    await tick();
    const channel = new BroadcastChannel(SOURCE);
    channel.postMessage({ source: SOURCE, code: 'VIA-CHANNEL', state: 'STATE-1', error: null });
    channel.close();

    await expect(done).resolves.toMatchObject({ id: 'conn-1' });
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ body: { code: 'VIA-CHANNEL', state: 'STATE-1' } });
  });

  it('stops before calling the API when the popup is blocked', async () => {
    popup = null;
    await expect(connectGoogle()).rejects.toThrow(/blocked/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not complete when the owner declines on Google', async () => {
    const done = connectGoogle();
    await tick();
    emit(ORIGIN, { source: SOURCE, code: null, state: 'STATE-1', error: 'access_denied' });
    await expect(done).rejects.toThrow(/not granted/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled while waiting for Google', async () => {
    const ac = new AbortController();
    const done = connectGoogle(ac.signal);
    await tick();
    ac.abort();
    await expect(done).rejects.toThrow(/Cancelled/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

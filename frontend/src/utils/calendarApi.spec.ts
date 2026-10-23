import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

import { announceCalendlyResult, openCalendlyPopup } from './calendarApi';

beforeEach(() => {
  // closed: true is what a popup looks like once Calendly's COOP header severs it.
  const popup = { closed: true, focus: vi.fn() };
  vi.stubGlobal('window', {
    open: vi.fn(() => popup),
    screenX: 0,
    screenY: 0,
    outerWidth: 1200,
    outerHeight: 900,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    BroadcastChannel,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('openCalendlyPopup', () => {
  it('waits through a severed popup and finishes on the channel', async () => {
    const done = openCalendlyPopup('https://auth.calendly.com/oauth/authorize?x=1');
    await new Promise((r) => setTimeout(r, 600));
    announceCalendlyResult(true);
    await expect(done).resolves.toEqual({ outcome: 'ok', message: null });
  });

  it('ends on cancel', async () => {
    const ac = new AbortController();
    const done = openCalendlyPopup('https://auth.calendly.com/oauth/authorize?x=1', ac.signal);
    ac.abort();
    await expect(done).resolves.toEqual({ outcome: 'closed', message: null });
  });
});

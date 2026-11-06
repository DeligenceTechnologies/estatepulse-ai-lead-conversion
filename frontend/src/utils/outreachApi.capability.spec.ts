import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../lib/api', async (actual) => ({ ...(await actual<typeof import('../lib/api')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));

/** A fresh module each time: the capability answer is cached per page load. */
const load = async () => {
  vi.resetModules();
  return import('./outreachApi');
};

describe('outreach scheduling switched off on the server (FU-06)', () => {
  beforeEach(() => apiFetch.mockReset());

  it('asks the flag once and never calls the endpoints that would answer 404', async () => {
    apiFetch.mockResolvedValue({ enabled: false });
    const { getOutreachConfig } = await load();
    expect(await Promise.all([getOutreachConfig(), getOutreachConfig()])).toEqual([null, null]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/outreach/enabled', { auth: true });
  });

  it('switched on, reads the config as before', async () => {
    const config = { timeZone: 'UTC', quietHours: null, maxConcurrentCalls: 5, reservedCallSlots: 1 };
    apiFetch.mockImplementation(async (path: string) => (path === '/outreach/enabled' ? { enabled: true } : config));
    const { getOutreachConfig } = await load();
    expect(await getOutreachConfig()).toEqual(config);
  });
});

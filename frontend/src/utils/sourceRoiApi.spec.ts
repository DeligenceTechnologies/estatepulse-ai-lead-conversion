import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const http = vi.hoisted(() => ({ fetch: null as unknown as Mock }));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiFetch: (...args: unknown[]) => http.fetch(...args),
}));

import { ApiError } from '../lib/api';
import { getRoiReport, putNoShow, putSpend, resetSourceRoiProbe, sourceRoiEnabled } from './sourceRoiApi';

beforeEach(() => {
  http.fetch = vi.fn();
  resetSourceRoiProbe();
});

describe('sourceRoiEnabled', () => {
  it('is on when the config route answers, and asks only once', async () => {
    http.fetch.mockResolvedValue({ enabled: true });
    expect(await sourceRoiEnabled()).toBe(true);
    expect(await sourceRoiEnabled()).toBe(true);
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.fetch).toHaveBeenCalledWith('/v1/source-roi/config', { auth: true });
  });

  it('is off when the route is not there, and remembers it', async () => {
    http.fetch.mockRejectedValue(new ApiError('NOT_FOUND', 'Not found', 404));
    expect(await sourceRoiEnabled()).toBe(false);
    expect(await sourceRoiEnabled()).toBe(false);
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('a network failure hides the feature for now but is asked again next time', async () => {
    http.fetch.mockRejectedValueOnce(new ApiError('NETWORK', 'Cannot reach the server', 0));
    expect(await sourceRoiEnabled()).toBe(false);
    http.fetch.mockResolvedValue({ enabled: true });
    expect(await sourceRoiEnabled()).toBe(true);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('Source ROI requests', () => {
  it('asks for the report by month range', async () => {
    http.fetch.mockResolvedValue({});
    await getRoiReport('2026-10', '2026-11');
    expect(http.fetch).toHaveBeenCalledWith('/v1/source-roi?from=2026-10&to=2026-11', { auth: true });
  });

  it('saves spend and no-shows with PUT', async () => {
    http.fetch.mockResolvedValue({});
    await putSpend({ leadSourceId: 's1', month: '2026-11', amount: 1500 });
    expect(http.fetch).toHaveBeenCalledWith('/v1/source-roi/spend', {
      method: 'PUT',
      body: { leadSourceId: 's1', month: '2026-11', amount: 1500 },
      auth: true,
    });
    await putNoShow('m1', true);
    expect(http.fetch).toHaveBeenLastCalledWith('/v1/source-roi/appointments/m1/no-show', { method: 'PUT', body: { noShow: true }, auth: true });
  });
});

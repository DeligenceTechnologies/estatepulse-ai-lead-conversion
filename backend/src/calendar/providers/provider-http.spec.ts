import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError, requestJson, retryAfter } from './provider-http';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('retryAfter', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');

  it('reads Retry-After in seconds', () => {
    expect(retryAfter(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
  });

  it('reads Retry-After as an HTTP date', () => {
    expect(retryAfter(new Headers({ 'retry-after': 'Thu, 15 Oct 2026 10:00:05 GMT' }), now)).toBe(5000);
  });

  it('reads X-RateLimit-Reset as seconds left or an epoch', () => {
    expect(retryAfter(new Headers({ 'x-ratelimit-reset': '2' }), now)).toBe(2000);
    expect(retryAfter(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 4) }), now)).toBe(4000);
  });

  it('is null when the provider gives no hint', () => {
    expect(retryAfter(new Headers(), now)).toBeNull();
  });
});

describe('requestJson', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('retries a rate-limited read after the wait the provider asked for', async () => {
    fetchMock
      .mockResolvedValueOnce(json(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(200, { ok: true }));

    const result = requestJson('Calendly', 'https://api.example.test/x');
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx read and gives up after three retries', async () => {
    fetchMock.mockImplementation(async () => json(503, { message: 'down' }));

    const result = requestJson('Calendly', 'https://api.example.test/x');
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('never retries a POST (a code exchange or refresh is single-use)', async () => {
    fetchMock.mockResolvedValueOnce(json(429, {}, { 'retry-after': '1' }));

    await expect(requestJson('Calendly', 'https://api.example.test/x', { method: 'POST' })).rejects.toMatchObject({
      status: 429,
      rateLimited: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails at once when the provider asks for a long wait', async () => {
    fetchMock.mockResolvedValueOnce(json(429, {}, { 'retry-after': '120' }));

    await expect(requestJson('Calendly', 'https://api.example.test/x')).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rejected credential', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { message: 'Unauthenticated' }));

    await expect(requestJson('Calendly', 'https://api.example.test/x')).rejects.toMatchObject({ credentialRejected: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

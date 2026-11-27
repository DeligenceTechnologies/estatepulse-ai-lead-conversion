import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLimitsService, REDIS_TIMEOUT_MS, TURN_TIMEOUT_MS } from './assistant-limits.service';

/** The few Redis commands the service uses, in memory. TTLs are ignored. */
function fakeRedis() {
  const store = new Map<string, string>();
  const client = {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    incr: vi.fn(async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    }),
    expire: vi.fn(async () => 1),
    // Only the compare-and-delete release script is used.
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => (store.get(key) === token ? (store.delete(key), 1) : 0)),
  };
  return { client };
}

describe('AssistantLimitsService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets one turn at a time run in a chat', async () => {
    const service = new AssistantLimitsService(fakeRedis() as any);
    const first = await service.lockThread('thread-1');
    await expect(service.lockThread('thread-1')).rejects.toMatchObject({ code: 'ASSISTANT_BUSY' });
    await first.release();
    await expect(service.lockThread('thread-1')).resolves.toBeDefined();
  });

  it('limits each user to 20 requests a minute', async () => {
    const service = new AssistantLimitsService(fakeRedis() as any);
    for (let i = 0; i < 20; i++) await service.consume('user-1');
    await expect(service.consume('user-1')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('stops a running turn when Stop is pressed, on whichever server runs it', async () => {
    const redis = fakeRedis();
    const service = new AssistantLimitsService(redis as any);
    const turn = await service.turnSignal('thread-1');
    expect(turn.signal.aborted).toBe(false);

    await service.requestStop('thread-1');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe('stopped');
    expect(redis.client.store.has('assistant:stop:thread-1')).toBe(false);
  });

  it('ignores a Stop left over from an earlier turn', async () => {
    const redis = fakeRedis();
    const service = new AssistantLimitsService(redis as any);
    await service.requestStop('thread-1');
    const turn = await service.turnSignal('thread-1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(turn.signal.aborted).toBe(false);
    turn.dispose();
  });

  it('cuts off a turn that runs past the time limit', async () => {
    const service = new AssistantLimitsService(fakeRedis() as any);
    const turn = await service.turnSignal('thread-1');
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe('timeout');
  });

  it('stops watching once the turn is over', async () => {
    const redis = fakeRedis();
    const service = new AssistantLimitsService(redis as any);
    const turn = await service.turnSignal('thread-1');
    turn.dispose();
    redis.client.get.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(redis.client.get).not.toHaveBeenCalled();
  });
});

describe('when Redis is down or slow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asking, locking a chat and Stop answer 503 "try again", not a server error', async () => {
    const redis = fakeRedis();
    const down = Object.assign(new Error('Reached the max retries per request limit'), { name: 'MaxRetriesPerRequestError' });
    redis.client.incr.mockRejectedValue(down);
    redis.client.set.mockRejectedValue(down);
    const service = new AssistantLimitsService(redis as any);
    const unavailable = { code: 'ASSISTANT_UNAVAILABLE', message: 'The assistant is briefly unavailable. Try again in a minute.' };
    await expect(service.consume('user-1')).rejects.toMatchObject(unavailable);
    await expect(service.lockThread('thread-1')).rejects.toMatchObject(unavailable);
    await expect(service.requestStop('thread-1')).rejects.toMatchObject(unavailable);
    await expect(service.consume('user-1')).rejects.toMatchObject({ status: 503 });
  });

  it('a Redis call that never answers gives up after the timeout instead of hanging', async () => {
    const redis = fakeRedis();
    redis.client.incr.mockReturnValue(new Promise(() => undefined));
    const service = new AssistantLimitsService(redis as any);
    const asked = service.consume('user-1');
    const settled = expect(asked).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(REDIS_TIMEOUT_MS + 1);
    await settled;
  });

  it('a rate limit is still a rate limit, and releasing a lock never fails the turn', async () => {
    const redis = fakeRedis();
    const service = new AssistantLimitsService(redis as any);
    for (let i = 0; i < 20; i++) await service.consume('user-1');
    await expect(service.consume('user-1')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const lock = await service.lockThread('thread-1');
    redis.client.eval.mockRejectedValue(new Error('connection reset'));
    await expect(lock.release()).resolves.toBeUndefined();
  });
});


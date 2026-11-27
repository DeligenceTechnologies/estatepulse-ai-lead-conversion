import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { RedisService } from '@/common/service/redis.service';

const REQUESTS_PER_MINUTE = 20;
/** Longer than any turn can run (see TURN_TIMEOUT_MS), so a crashed turn frees its chat on its own. */
const TURN_LOCK_MS = 5 * 60_000;
/** A turn still running after this is cut off. Shorter than the lock, so the lock always outlives the turn. */
export const TURN_TIMEOUT_MS = 4 * 60_000;
/** How often a running turn looks for a Stop. The flag lives in Redis, so Stop reaches whichever server runs the turn. */
const STOP_POLL_MS = 1_000;
const STOP_TTL_MS = 60_000;

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** A Redis call slower than this counts as Redis being down, so a request never hangs on it. */
export const REDIS_TIMEOUT_MS = 3_000;
const UNAVAILABLE = 'The assistant is briefly unavailable. Try again in a minute.';

export interface TurnLock {
  release(): Promise<void>;
}

/** Why a turn's signal fired. */
export type TurnAbortReason = 'timeout' | 'stopped';

export interface TurnSignal {
  signal: AbortSignal;
  dispose(): void;
}

@Injectable()
export class AssistantLimitsService {
  private readonly logger = new Logger(AssistantLimitsService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * One Redis step of the assistant. When Redis is down or slow the person gets a clear "try again"
   * (503 ASSISTANT_UNAVAILABLE) instead of a server error or a request that hangs.
   */
  private async call<T>(what: string, work: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${REDIS_TIMEOUT_MS} ms`)), REDIS_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn(`Redis ${what} failed: ${(error as Error)?.message ?? String(error)}`);
      throw new AppError('ASSISTANT_UNAVAILABLE', UNAVAILABLE, undefined, 503);
    } finally {
      clearTimeout(timer);
    }
  }

  async consume(userId: string): Promise<void> {
    const key = `assistant:rate:${userId}:${Math.floor(Date.now() / 60_000)}`;
    const count = await this.call('rate limit', async () => {
      const n = await this.redis.client.incr(key);
      if (n === 1) await this.redis.client.expire(key, 61);
      return n;
    });
    if (count > REQUESTS_PER_MINUTE) {
      throw new AppError('RATE_LIMITED', 'Too many assistant requests. Wait a minute and try again.');
    }
  }

  /** One turn at a time per chat: a second tab or a double submit waits instead of interleaving history. */
  async lockThread(threadId: string): Promise<TurnLock> {
    const key = `assistant:turn:${threadId}`;
    const token = randomUUID();
    const taken = await this.call('turn lock', () => this.redis.client.set(key, token, 'PX', TURN_LOCK_MS, 'NX'));
    if (taken !== 'OK') throw new AppError('ASSISTANT_BUSY', 'The assistant is still answering in this chat.', undefined, 409);
    return {
      // Never fails the turn: a lock left behind expires on its own after TURN_LOCK_MS.
      release: async () => {
        await this.call('turn unlock', () => this.redis.client.eval(RELEASE, 1, key, token)).catch(() => undefined);
      },
    };
  }

  /** Asks the turn running in this chat to stop after the step it is on. */
  async requestStop(threadId: string): Promise<void> {
    await this.call('stop', () => this.redis.client.set(stopKey(threadId), '1', 'PX', STOP_TTL_MS));
  }

  /**
   * The signal one turn runs under. It fires when the turn runs past TURN_TIMEOUT_MS or someone presses
   * Stop. The browser going away does not fire it: the turn finishes and is saved.
   */
  async turnSignal(threadId: string): Promise<TurnSignal> {
    const key = stopKey(threadId);
    // A Stop pressed before this turn began was meant for an earlier one.
    await this.call('stop reset', () => this.redis.client.del(key));
    const controller = new AbortController();
    const abort = (reason: TurnAbortReason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const timeout = setTimeout(() => abort('timeout'), TURN_TIMEOUT_MS);
    const poll = setInterval(() => {
      this.redis.client
        .get(key)
        .then(async (flag) => {
          if (!flag) return;
          await this.redis.client.del(key);
          abort('stopped');
        })
        .catch(() => undefined); // Redis hiccup: look again on the next tick.
    }, STOP_POLL_MS);
    timeout.unref?.();
    poll.unref?.();
    const dispose = () => {
      clearTimeout(timeout);
      clearInterval(poll);
    };
    controller.signal.addEventListener('abort', dispose, { once: true });
    return { signal: controller.signal, dispose };
  }
}

const stopKey = (threadId: string) => `assistant:stop:${threadId}`;

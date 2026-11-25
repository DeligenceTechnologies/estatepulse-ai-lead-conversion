import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { RedisService } from '@/common/service/redis.service';

const REQUESTS_PER_MINUTE = 20;
/** Longer than any turn can run (8 model calls plus tools), so a crashed turn frees its chat on its own. */
const TURN_LOCK_MS = 5 * 60_000;

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface TurnLock {
  release(): Promise<void>;
}

@Injectable()
export class AssistantLimitsService {
  constructor(private readonly redis: RedisService) {}

  async consume(userId: string): Promise<void> {
    const key = `assistant:rate:${userId}:${Math.floor(Date.now() / 60_000)}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, 61);
    if (count > REQUESTS_PER_MINUTE) {
      throw new AppError('RATE_LIMITED', 'Too many Copilot requests. Wait a minute and try again.');
    }
  }

  /** One turn at a time per chat: a second tab or a double submit waits instead of interleaving history. */
  async lockThread(threadId: string): Promise<TurnLock> {
    const key = `assistant:turn:${threadId}`;
    const token = randomUUID();
    const taken = await this.redis.client.set(key, token, 'PX', TURN_LOCK_MS, 'NX');
    if (taken !== 'OK') throw new AppError('ASSISTANT_BUSY', 'Copilot is still answering in this chat.', undefined, 409);
    return {
      release: async () => {
        await this.redis.client.eval(RELEASE, 1, key, token);
      },
    };
  }
}

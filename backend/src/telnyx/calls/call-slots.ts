import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@/common/service/redis.service';
import type { QueueEnv } from '@/common/utils/interface';
import { QUEUE_PREFIX } from '@/queue/queue.constants';

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
return 1
`;

const RENAME = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], score, ARGV[2])
return 1
`;

@Injectable()
export class CallSlots {
  private readonly ttlMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<QueueEnv, true>,
  ) {
    this.ttlMs = config.get('CALL_SLOT_TTL_MS', { infer: true });
  }

  private key(orgId: string): string {
    return `${QUEUE_PREFIX}:calls:active:${orgId}`;
  }

  async acquire(orgId: string, slotId: string, limit: number): Promise<boolean> {
    const now = Date.now();
    const taken = await this.redis.client.eval(ACQUIRE, 1, this.key(orgId), now, limit, slotId, now + this.ttlMs);
    return Number(taken) === 1;
  }

  async rename(orgId: string, from: string, to: string): Promise<void> {
    await this.redis.client.eval(RENAME, 1, this.key(orgId), from, to);
  }

  async extend(orgId: string, slotId: string): Promise<void> {
    await this.redis.client.zadd(this.key(orgId), 'XX', Date.now() + this.ttlMs, slotId);
  }

  async release(orgId: string, slotId: string): Promise<void> {
    await this.redis.client.zrem(this.key(orgId), slotId);
  }

  async inUse(orgId: string): Promise<number> {
    const key = this.key(orgId);
    await this.redis.client.zremrangebyscore(key, '-inf', Date.now());
    return this.redis.client.zcard(key);
  }
}

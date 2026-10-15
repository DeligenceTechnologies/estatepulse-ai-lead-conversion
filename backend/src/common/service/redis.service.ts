import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisOptions } from '@/common/config/redis.config';
import type { QueueEnv } from '@/common/utils/interface';

const PING_TIMEOUT_MS = 2_000;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService<QueueEnv, true>) {
    this.client = new Redis({
      ...redisOptions(config.getOrThrow('REDIS_URL', { infer: true })),
      connectionName: 'estatepulse-api',
      maxRetriesPerRequest: 2,
    });
    this.client.on('error', (error: Error) => this.logger.warn(`Redis error: ${error.message}`));
  }

  async ping(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS);
        }),
      ]);
      return reply === 'PONG';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

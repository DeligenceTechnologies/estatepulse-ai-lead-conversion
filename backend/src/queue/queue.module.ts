import { BullModule, type RegisterQueueOptions } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redisOptions } from '@/common/config/redis.config';
import type { QueueEnv } from '@/common/utils/interface';
import { EmailQueue } from './email/email.queue';
import { EmailWorker } from './email/email.worker';
import { CALL_QUEUE, EMAIL_QUEUE } from './queue.constants';

const DAY_SECONDS = 24 * 60 * 60;

const RETENTION = {
  removeOnComplete: { age: DAY_SECONDS, count: 1_000 },
  removeOnFail: { age: 7 * DAY_SECONDS },
};

const QUEUES: RegisterQueueOptions[] = [
  {
    name: EMAIL_QUEUE,
    defaultJobOptions: { attempts: 6, backoff: { type: 'exponential', delay: 15_000 }, ...RETENTION },
  },
  {
    name: CALL_QUEUE,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, ...RETENTION },
  },
];

const PRODUCERS = [EmailQueue];
const WORKERS = [EmailWorker];

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<QueueEnv, true>) => ({
        connection: { ...redisOptions(config.getOrThrow('REDIS_URL', { infer: true })), connectionName: 'estatepulse-queue' },
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, ...RETENTION },
      }),
    }),
    BullModule.registerQueue(...QUEUES),
  ],
  providers: [...PRODUCERS, ...WORKERS],
  exports: [BullModule, ...PRODUCERS],
})
export class QueueModule {}

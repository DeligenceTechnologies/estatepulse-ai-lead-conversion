import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { NANGO_QUEUE } from './nango.constants';
import { NangoConnectionRegistry } from './nango-connection.registry';
import { NangoWebhookController } from './nango-webhook.controller';
import { NangoWebhookService } from './nango-webhook.service';
import { NangoWebhookWorker } from './nango-webhook.worker';
import { NangoService } from './nango.service';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Nango as the credential store for every OAuth provider: connect sessions,
 * tokens, and Nango's own webhooks. Global, so each provider module injects
 * NangoService and registers its NangoConnectionHandler without importing this.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: NANGO_QUEUE,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: DAY_SECONDS, count: 1_000 },
        removeOnFail: { age: 7 * DAY_SECONDS },
      },
    }),
  ],
  controllers: [NangoWebhookController],
  providers: [NangoService, NangoConnectionRegistry, NangoWebhookService, NangoWebhookWorker],
  exports: [NangoService, NangoConnectionRegistry],
})
export class NangoModule {}

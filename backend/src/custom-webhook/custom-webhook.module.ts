import { Module } from '@nestjs/common';
import { IngestModule } from '@/ingest/ingest.module';
import { LeadSourceModule } from '@/lead-source/lead-source.module';
import { CustomWebhookIngestController } from './custom-webhook-ingest.controller';
import { CustomWebhookIngestService } from './custom-webhook-ingest.service';
import { CustomWebhookController } from './custom-webhook.controller';
import { CustomWebhookService } from './custom-webhook.service';

/**
 * Custom webhook sources: a URL any app can post a lead to, mapped by the
 * owner from the first payload that arrives.
 *
 * Its own module, beside the form-provider ingestion rather than inside it, so
 * the Tally and Typeform routes are untouched. The worker, the normalizers, the
 * mapping tables and the deliveries screen are shared — a custom delivery is an
 * ingest_events row like any other once it is in.
 */
@Module({
  imports: [IngestModule, LeadSourceModule],
  controllers: [CustomWebhookIngestController, CustomWebhookController],
  providers: [CustomWebhookIngestService, CustomWebhookService],
})
export class CustomWebhookModule {}

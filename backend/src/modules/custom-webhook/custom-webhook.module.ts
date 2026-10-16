import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadSourcesModule } from '../lead-sources/lead-sources.module';
import { ProcessingModule } from '../processing/processing.module';
import { CustomWebhookIngestController } from './custom-webhook-ingest.controller';
import { CustomWebhookIngestService } from './custom-webhook-ingest.service';
import { CustomWebhookController } from './custom-webhook.controller';
import { CustomWebhookService } from './custom-webhook.service';

/**
 * Custom webhook sources: a URL any app can post a lead to, mapped by the
 * owner from the first payload that arrives.
 *
 * Its own module, beside the form-provider ingestion rather than inside it:
 * the public route, the verifier and the store step are separate classes so
 * the Tally path is untouched. The worker, the normalizers, the mapping tables
 * and the deliveries screen are shared — a custom delivery is a
 * webhook_events row like any other once it is in.
 *
 * TODO(phase-5-manifests): fold CustomWebhookIngestService's store step into
 * IngestService once that service takes a provider, as the Typeform branch
 * makes it do; the two write the same row shape.
 */
@Module({
  imports: [PrismaModule, AuthModule, ProcessingModule, LeadSourcesModule],
  controllers: [CustomWebhookIngestController, CustomWebhookController],
  providers: [CustomWebhookIngestService, CustomWebhookService],
})
export class CustomWebhookModule {}

import { Module } from '@nestjs/common';
import { IngestModule } from '@/ingest/ingest.module';
import { IntegrationModule } from '@/integration/integration.module';
import { ConnectService } from './connect.service';
import { LeadSourcesController, WebhookSourcesController } from './lead-sources.controller';
import { LeadSourcesService } from './lead-sources.service';

@Module({
  imports: [IngestModule, IntegrationModule],
  controllers: [LeadSourcesController, WebhookSourcesController],
  providers: [LeadSourcesService, ConnectService],
  exports: [LeadSourcesService],
})
export class LeadSourceModule {}

import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from '@/google-sheets/google-sheets.module';
import { CrmConnectionsService } from './crm-connections.service';
import { CrmController } from './crm.controller';
import { CrmRegistry } from './crm-registry';
import { CrmSyncService } from './crm-sync.service';
import { CrmWebhooksController } from './crm-webhooks.controller';
import { CrmWebhooksService } from './crm-webhooks.service';
import { HubSpotClient } from './hubspot/hubspot.client';

/** CRM integrations (HubSpot today), importing through the Google Sheets engine and its review queue. */
@Module({
  imports: [GoogleSheetsModule],
  controllers: [CrmController, CrmWebhooksController],
  providers: [HubSpotClient, CrmRegistry, CrmConnectionsService, CrmSyncService, CrmWebhooksService],
})
export class CrmModule {}

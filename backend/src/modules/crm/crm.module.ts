import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { CrmConnectionsService } from './crm-connections.service';
import { CrmController } from './crm.controller';
import { CrmRegistry } from './crm-registry';
import { CrmSyncService } from './crm-sync.service';
import { CrmWebhooksController } from './crm-webhooks.controller';
import { CrmWebhooksService } from './crm-webhooks.service';
import { HubSpotClient } from './hubspot/hubspot.client';

/**
 * CRM integrations (HubSpot today). AuthModule for the guards; GoogleSheetsModule
 * for the import engine and review queue every import shares; Prisma and the
 * EventsBus are global.
 */
@Module({
  imports: [AuthModule, GoogleSheetsModule],
  controllers: [CrmController, CrmWebhooksController],
  providers: [HubSpotClient, CrmRegistry, CrmConnectionsService, CrmSyncService, CrmWebhooksService],
})
export class CrmModule {}

import { Module } from '@nestjs/common';
import { CalendarModule } from '@/calendar/calendar.module';
import { EventsModule } from '@/events/events.module';
import { AdapterRegistry } from './adapters/adapter.registry';
import type { IntegrationAdapter } from './adapters/adapter.interface';
import { AirtableAdapter } from './adapters/airtable/airtable.adapter';
import { CalComAdapter } from './adapters/cal-com/cal-com.adapter';
import { CalendlyAdapter } from './adapters/calendly/calendly.adapter';
import { GoogleSheetsAdapter } from './adapters/google-sheets/google-sheets.adapter';
import { HubSpotAdapter } from './adapters/hubspot/hubspot.adapter';
import { TallyAdapter } from './adapters/tally/tally.adapter';
import { TypeformAdapter } from './adapters/typeform/typeform.adapter';
import { ConnectionsController } from './connections/connections.controller';
import { ConnectionsService } from './connections/connections.service';
import { INTEGRATION_ADAPTERS } from './integrations.constants';
import { NangoModule } from './nango/nango.module';
import { ProvidersController } from './providers/providers.controller';
import { ProvidersService } from './providers/providers.service';
import { LeadImporterService } from './sync/lead-importer.service';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';
import { SyncScheduler } from './sync/sync.scheduler';
import { WriteBackService } from './sync/write-back.service';
import { IntegrationSyncWorker } from './sync/sync.worker';
import { NangoWebhooksController } from './webhooks/webhooks.controller';
import { NangoWebhooksService } from './webhooks/webhooks.service';

/**
 * The providers EstatePulse implements. Adding one = write an adapter
 * (adapters/<provider>/) and list it here; the marketplace, connect flow,
 * sync queue and webhooks pick it up unchanged.
 */
const ADAPTERS = [AirtableAdapter, HubSpotAdapter, TallyAdapter, TypeformAdapter, GoogleSheetsAdapter, CalComAdapter, CalendlyAdapter];

/**
 * The Integration Marketplace on Nango: catalog, connections, syncs and
 * webhooks. PrismaService, AuditService, RedisService and LeadIntakeService come
 * from the global ServiceProviderModule; the BullMQ queue from the global QueueModule.
 */
@Module({
  imports: [EventsModule, NangoModule, CalendarModule],
  controllers: [ProvidersController, ConnectionsController, SyncController, NangoWebhooksController],
  providers: [
    ...ADAPTERS,
    {
      provide: INTEGRATION_ADAPTERS,
      inject: ADAPTERS,
      useFactory: (...adapters: IntegrationAdapter[]) => adapters,
    },
    AdapterRegistry,
    ProvidersService,
    ConnectionsService,
    SyncService,
    LeadImporterService,
    WriteBackService,
    SyncScheduler,
    IntegrationSyncWorker,
    NangoWebhooksService,
  ],
  exports: [NangoModule, ConnectionsService],
})
export class IntegrationsModule {}

import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from '@/google-sheets/google-sheets.module';
import { AirtableClient } from './airtable.client';
import { AirtableConnectionsService } from './airtable-connections.service';
import { AirtableSourcesService } from './airtable-sources.service';
import { AirtableController } from './airtable.controller';
import { AirtableSyncService } from './airtable-sync.service';
import { AirtableWebhooksController } from './airtable-webhooks.controller';

/**
 * Airtable: connecting an account, and syncing one table per lead source.
 *
 * Imports the Google Sheets module for SheetImportService — the engine that
 * turns a built row into a lead, with the duplicate checks, Import Review and
 * automation safety rules every other import already goes through.
 */
@Module({
  imports: [GoogleSheetsModule],
  controllers: [AirtableController, AirtableWebhooksController],
  providers: [AirtableClient, AirtableConnectionsService, AirtableSourcesService, AirtableSyncService],
  exports: [AirtableClient, AirtableConnectionsService, AirtableSourcesService, AirtableSyncService],
})
export class AirtableModule {}

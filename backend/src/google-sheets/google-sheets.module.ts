import { Module } from '@nestjs/common';
import { GoogleConnectionsService } from './google-connections.service';
import { GoogleSheetsController, ImportReviewController } from './google-sheets.controller';
import { GoogleClient } from './google.client';
import { SheetImportService } from './sheet-import.service';
import { SheetReviewService } from './sheet-review.service';
import { SheetSourcesService } from './sheet-sources.service';

@Module({
  controllers: [GoogleSheetsController, ImportReviewController],
  providers: [GoogleClient, GoogleConnectionsService, SheetImportService, SheetSourcesService, SheetReviewService],
  // GoogleClient and the connection service are exported for the Google Forms
  // module: one Google account per organization, one OAuth flow, one token
  // refresh. Forms must not grow a second connection system beside Sheets'.
  exports: [SheetImportService, SheetReviewService, GoogleClient, GoogleConnectionsService],
})
export class GoogleSheetsModule {}

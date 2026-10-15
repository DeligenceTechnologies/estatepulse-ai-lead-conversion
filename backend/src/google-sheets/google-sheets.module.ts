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
  exports: [SheetImportService, SheetReviewService],
})
export class GoogleSheetsModule {}

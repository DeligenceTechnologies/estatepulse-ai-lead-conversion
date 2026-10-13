import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { GoogleConnectionsService } from './google-connections.service';
import { GoogleSheetsController } from './google-sheets.controller';
import { GoogleClient } from './google.client';
import { ImportReviewController } from './import-review.controller';
import { SheetImportService } from './sheet-import.service';
import { SheetReviewService } from './sheet-review.service';
import { SheetSourcesController } from './sheet-sources.controller';
import { SheetSourcesService } from './sheet-sources.service';

/** Google Sheets lead import. AuthModule for the guards; Prisma and EventsBus are global. */
@Module({
  imports: [AuthModule],
  controllers: [GoogleSheetsController, SheetSourcesController, ImportReviewController],
  providers: [GoogleClient, GoogleConnectionsService, SheetImportService, SheetSourcesService, SheetReviewService],
  // The file upload (FileImportModule) writes its rows through the same engine,
  // and rejects a removed upload's pending rows through the same review service.
  exports: [SheetImportService, SheetReviewService],
})
export class GoogleSheetsModule {}

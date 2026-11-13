import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from '@/google-sheets/google-sheets.module';
import { IngestModule } from '@/ingest/ingest.module';
import { LeadSourceModule } from '@/lead-source/lead-source.module';
import { FormsPollService } from './forms-poll.service';
import { GoogleFormsController } from './google-forms.controller';
import { GoogleFormsService } from './google-forms.service';

/**
 * Google Forms sources.
 *
 * Its own module, beside the other integrations rather than inside one of
 * them, so Google Sheets' sync is untouched — but it imports rather than
 * duplicates everything that already exists:
 *
 *   GoogleSheetsModule  the one Google OAuth connection per organization, its
 *                       token refresh, and the HTTP client the Forms API calls
 *                       go through
 *   IngestModule        the delivery table and the worker that turns a
 *                       delivery into a lead — the same one Tally and Typeform
 *                       use, which is why there is no Google Forms lead path
 *   LeadSourceModule    ingest tokens, signing secrets and the webhook URL
 */
@Module({
  imports: [GoogleSheetsModule, IngestModule, LeadSourceModule],
  controllers: [GoogleFormsController],
  providers: [GoogleFormsService, FormsPollService],
  exports: [GoogleFormsService],
})
export class GoogleFormsModule {}

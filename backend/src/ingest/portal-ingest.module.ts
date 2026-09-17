import { Module, forwardRef } from '@nestjs/common';
import { TelnyxModule } from '../telnyx/telnyx.module';
import { PortalIngestAliasController, PortalIngestController } from './portal-ingest.controller';
import { PortalIngestService } from './portal-ingest.service';

/**
 * The portal's simple lead webhook — "paste this URL into anything".
 *
 * Separate from modules/ingest, which is the form-provider pipeline (signature
 * verification, stored deliveries, worker-driven field mapping). This one
 * creates the lead inline and enrols it immediately.
 */
@Module({
  imports: [forwardRef(() => TelnyxModule)],
  controllers: [PortalIngestController, PortalIngestAliasController],
  providers: [PortalIngestService],
  exports: [PortalIngestService],
})
export class PortalIngestModule {}

import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PortalIngestModule } from '../ingest/portal-ingest.module';
import { ActivityService } from './activity.service';
import { AssistantService } from './assistant.service';
import { CredStoreService } from './cred-store.service';
import { EngineService } from './engine.service';
import { LeadWatcherService } from './lead-watcher.service';
import { NumbersService } from './numbers.service';
import {
  AssistantController,
  IngestSourcesController,
  PortalLeadsController,
  StrategyController,
} from './portal.controller';
import { SecretCipherService } from './secret-cipher.service';
import { SmsService } from './sms.service';
import { StrategyStoreService } from './strategy-store.service';
import { OrgIntegrationsController, TelnyxController } from './telnyx.controller';
import { TelnyxWebhookController } from './telnyx-webhook.controller';
import { VoiceService } from './voice.service';

/**
 * Bring-Your-Own-Telnyx: provider credentials, the AI assistant, phone numbers,
 * the outbound strategy and the engine that executes it.
 *
 * forwardRef to PortalIngestModule because the two genuinely need each other:
 * ingestion enrolls a new lead into the engine, and the dashboard's source
 * management lives on this side. Nest resolves the cycle as long as it is
 * declared on both ends.
 */
@Module({
  imports: [AuthModule, forwardRef(() => PortalIngestModule)],
  controllers: [
    TelnyxController,
    OrgIntegrationsController,
    AssistantController,
    StrategyController,
    PortalLeadsController,
    IngestSourcesController,
    TelnyxWebhookController,
  ],
  providers: [
    SecretCipherService,
    CredStoreService,
    ActivityService,
    AssistantService,
    NumbersService,
    SmsService,
    VoiceService,
    StrategyStoreService,
    EngineService,
    LeadWatcherService,
  ],
  exports: [EngineService, CredStoreService],
})
export class TelnyxModule {}

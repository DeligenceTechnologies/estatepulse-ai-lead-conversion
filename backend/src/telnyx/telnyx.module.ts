import { Module, forwardRef } from '@nestjs/common';
import { CallingProviders, TelnyxCallingProvider } from '@/calling/calling-providers';
import { FollowupModule } from '@/followup/followup.module';
import { RetellCallingProvider } from '@/retell/retell-calling.provider';
import { RetellCredentialsService } from '@/retell/retell-credentials.service';
import { ActivityService } from './activity.service';
import { AssistantService } from './assistant.service';
import { CallCapacityService } from './calls/call-capacity.service';
import { CallSlots } from './calls/call-slots';
import { CallQueue } from './calls/call.queue';
import { CallWorker } from './calls/call.worker';
import { EngineService } from './engine.service';
import { InboundSmsService } from './inbound-sms.service';
import { LeadInsightsService } from './lead-insights.service';
import { LeadScoringService } from './lead-scoring.service';
import { LeadWatcherService } from './lead-watcher.service';
import { NumbersService } from './numbers.service';
import { AssistantController, LeadScoringController, PortalLeadsController, StrategyController } from './portal.controller';
import { SmsService } from './sms.service';
import { SmsConversationController } from './sms/sms-conversation.controller';
import { SmsConversationService } from './sms/sms-conversation.service';
import { SmsIntentService } from './sms/sms-intent.service';
import { StrategyStoreService } from './strategy-store.service';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { TelnyxWebhookController } from './telnyx-webhook.controller';
import { TelnyxController } from './telnyx.controller';
import { VoiceService } from './voice.service';
import { AssistantToolAuth } from './tools/assistant-tool-auth.service';
import { CallOutcomeToolController, CallToolsSettingsController } from './tools/call-tools.controller';
import { CallToolsService } from './tools/call-tools.service';
import { CallbackService } from './tools/callback.service';
import { OutcomeService } from './tools/outcome.service';
import { VoicemailController } from './voicemail/voicemail.controller';
import { VoicemailService } from './voicemail/voicemail.service';

@Module({
  imports: [forwardRef(() => FollowupModule)],
  controllers: [
    TelnyxController,
    AssistantController,
    StrategyController,
    LeadScoringController,
    PortalLeadsController,
    TelnyxWebhookController,
    SmsConversationController,
    VoicemailController,
    CallOutcomeToolController,
    CallToolsSettingsController,
  ],
  providers: [
    TelnyxCredentialsService,
    ActivityService,
    AssistantService,
    CallCapacityService,
    CallingProviders,
    CallQueue,
    CallSlots,
    CallWorker,
    EngineService,
    InboundSmsService,
    LeadInsightsService,
    LeadScoringService,
    LeadWatcherService,
    NumbersService,
    RetellCallingProvider,
    RetellCredentialsService,
    SmsService,
    SmsConversationService,
    SmsIntentService,
    StrategyStoreService,
    TelnyxCallingProvider,
    VoiceService,
    VoicemailService,
    AssistantToolAuth,
    CallToolsService,
    CallbackService,
    OutcomeService,
  ],
  exports: [
    CallQueue,
    CallSlots,
    EngineService,
    TelnyxCredentialsService,
    SmsService,
    ActivityService,
    StrategyStoreService,
    AssistantService,
    AssistantToolAuth,
    SmsConversationService,
    CallingProviders,
    LeadScoringService,
    RetellCredentialsService,
  ],
})
export class TelnyxModule {}

import { Module, forwardRef } from '@nestjs/common';
import { FollowupModule } from '@/followup/followup.module';
import { StepGuardModule } from '@/outreach/step-guard.module';
import { ActivityService } from './activity.service';
import { AssistantService } from './assistant.service';
import { CallCapacityService } from './calls/call-capacity.service';
import { CallSlots } from './calls/call-slots';
import { CallQueue } from './calls/call.queue';
import { CallWorker } from './calls/call.worker';
import { EngineService } from './engine.service';
import { InboundSmsService } from './inbound-sms.service';
import { LeadInsightsService } from './lead-insights.service';
import { LeadAutomationController } from './lead-automation.controller';
import { LeadScoringService } from './lead-scoring.service';
import { LeadWatcherService } from './lead-watcher.service';
import { NumbersService } from './numbers.service';
import { AssistantController, LeadScoringController, PortalLeadsController, StrategyController } from './portal.controller';
import { SmsService } from './sms.service';
import { StrategyStoreService } from './strategy-store.service';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { TelnyxWebhookController } from './telnyx-webhook.controller';
import { TelnyxController } from './telnyx.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [forwardRef(() => FollowupModule), StepGuardModule],
  controllers: [TelnyxController, AssistantController, StrategyController, LeadScoringController, PortalLeadsController, LeadAutomationController, TelnyxWebhookController],
  providers: [
    TelnyxCredentialsService,
    ActivityService,
    AssistantService,
    CallCapacityService,
    CallQueue,
    CallSlots,
    CallWorker,
    EngineService,
    InboundSmsService,
    LeadInsightsService,
    LeadScoringService,
    LeadWatcherService,
    NumbersService,
    SmsService,
    StrategyStoreService,
    VoiceService,
  ],
  exports: [CallQueue, CallSlots, EngineService, TelnyxCredentialsService, SmsService, ActivityService, StrategyStoreService, AssistantService],
})
export class TelnyxModule {}

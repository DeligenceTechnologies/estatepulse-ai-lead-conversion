import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CalendarModule } from '@/calendar/calendar.module';
import { FollowupModule } from '@/followup/followup.module';
import { HistoryModule } from '@/history/history.module';
import { LeadModule } from '@/lead/lead.module';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { AssistantActionService } from './assistant-action.service';
import { AssistantLimitsService } from './assistant-limits.service';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { AssistantRefService } from './assistant-ref.service';
import { AssistantThreadService } from './assistant-thread.service';
import { AssistantUsageService } from './assistant-usage.service';
import { AssistantConfig, createModelProvider } from './assistant.config';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { MODEL_PROVIDER } from './providers/model-provider';
import { ToolRegistry } from './tools/tool-registry.service';

@Module({
  imports: [LeadModule, HistoryModule, CalendarModule, TelnyxModule, FollowupModule],
  controllers: [AssistantController],
  providers: [
    { provide: AssistantConfig, inject: [ConfigService], useFactory: AssistantConfig.fromConfigService },
    { provide: MODEL_PROVIDER, inject: [AssistantConfig], useFactory: createModelProvider },
    ToolRegistry,
    AssistantRefService,
    AssistantUsageService,
    AssistantLimitsService,
    AssistantThreadService,
    AssistantActionService,
    AssistantOrchestrator,
    AssistantService,
  ],
})
export class AssistantModule {}

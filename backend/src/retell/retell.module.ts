import { Module } from '@nestjs/common';
import { CalendarModule } from '@/calendar/calendar.module';
import { CallingProviderController } from '@/calling/calling-provider.controller';
import { CallingSwitchService } from '@/calling/calling-switch.service';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { RetellAccountService } from './retell-account.service';
import { RetellChatSyncService } from './retell-chat-sync.service';
import { RetellOutcomeToolController } from './retell-tools.controller';
import { RetellWebhookController } from './retell-webhook.controller';
import { RetellController } from './retell.controller';

/**
 * Retell as an organization's calling provider, and the switch between it and
 * Telnyx. Every route answers 404 unless RETELL_ENABLED. The Retell
 * credentials, call provider, SMS and tool services live in TelnyxModule
 * beside the registry that picks between the two providers.
 */
@Module({
  imports: [TelnyxModule, CalendarModule],
  controllers: [RetellController, RetellWebhookController, RetellOutcomeToolController, CallingProviderController],
  providers: [RetellAccountService, RetellChatSyncService, CallingSwitchService],
})
export class RetellModule {}

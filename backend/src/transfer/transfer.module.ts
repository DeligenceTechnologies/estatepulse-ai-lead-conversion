import { Module } from '@nestjs/common';
import { LeadModule } from '@/lead/lead.module';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { AgentRouterService } from './agent-router.service';
import { CallTransferService } from './call-transfer.service';
import { LiveTransferController, TransferToolController } from './live-transfer.controller';
import { LiveTransferSettingsService } from './live-transfer-settings.service';

/** Live transfer of a hot lead's AI call to an available agent, with booking as the fallback. */
@Module({
  imports: [TelnyxModule, LeadModule],
  controllers: [TransferToolController, LiveTransferController],
  providers: [AgentRouterService, CallTransferService, LiveTransferSettingsService],
})
export class TransferModule {}

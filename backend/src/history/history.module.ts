import { Module } from '@nestjs/common';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

@Module({
  imports: [TelnyxModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}

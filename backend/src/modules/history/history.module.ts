import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TelnyxModule } from '../../telnyx/telnyx.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/**
 * AuthModule is imported for SessionGuard, which it provides and exports;
 * TelnyxModule for ActivityService, which re-signs recording links.
 */
@Module({
  imports: [PrismaModule, AuthModule, TelnyxModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}

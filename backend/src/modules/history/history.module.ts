import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/** AuthModule is imported for SessionGuard, which it provides and exports. */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}

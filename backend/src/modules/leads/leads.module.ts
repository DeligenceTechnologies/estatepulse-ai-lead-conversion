import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/api-key.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadsController } from './leads.controller';

@Module({
  imports: [PrismaModule],
  controllers: [LeadsController],
  providers: [ApiKeyGuard],
})
export class LeadsModule {}

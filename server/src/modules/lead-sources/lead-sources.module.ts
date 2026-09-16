import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/api-key.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadSourcesController } from './lead-sources.controller';
import { LeadSourcesService } from './lead-sources.service';

@Module({
  imports: [PrismaModule],
  controllers: [LeadSourcesController],
  providers: [LeadSourcesService, ApiKeyGuard],
})
export class LeadSourcesModule {}

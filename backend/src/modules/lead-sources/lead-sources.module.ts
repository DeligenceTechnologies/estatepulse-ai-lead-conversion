import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/api-key.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProvidersModule } from '../providers/providers.module';
import { ConnectService } from './connect.service';
import { LeadSourcesController } from './lead-sources.controller';
import { LeadSourcesService } from './lead-sources.service';

@Module({
  imports: [PrismaModule, ProvidersModule, IntegrationsModule],
  controllers: [LeadSourcesController],
  providers: [LeadSourcesService, ConnectService, ApiKeyGuard],
})
export class LeadSourcesModule {}

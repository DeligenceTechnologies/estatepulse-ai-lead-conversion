import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProvidersModule } from '../providers/providers.module';
import { ConnectService } from './connect.service';
import { LeadSourcesController } from './lead-sources.controller';
import { LeadSourcesService } from './lead-sources.service';

@Module({
  imports: [PrismaModule, ProvidersModule, IntegrationsModule, AuthModule],
  controllers: [LeadSourcesController],
  providers: [LeadSourcesService, ConnectService],
})
export class LeadSourcesModule {}

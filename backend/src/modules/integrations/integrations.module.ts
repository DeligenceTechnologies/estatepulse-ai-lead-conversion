import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/api-key.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [PrismaModule, ProvidersModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, ApiKeyGuard],
  // Exported because the connect flow in LeadSourcesModule needs to decrypt a
  // credential — and that decryption must live in exactly one place.
  exports: [IntegrationsService],
})
export class IntegrationsModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [PrismaModule, ProvidersModule, AuthModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  // Exported because the connect flow in LeadSourcesModule needs to decrypt a
  // credential — and that decryption must live in exactly one place.
  exports: [IntegrationsService],
})
export class IntegrationsModule {}

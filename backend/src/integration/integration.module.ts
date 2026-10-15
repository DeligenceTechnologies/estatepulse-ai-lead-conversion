import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';
import { IntegrationsController, OrgIntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { FORM_PROVIDER_ADAPTERS, ProviderRegistry } from './providers/provider.registry';
import { TallyClient } from './providers/tally/tally.client';
import { TallyProviderAdapter } from './providers/tally/tally.provider';
import type { FormProviderAdapter } from './providers/types';

@Module({
  controllers: [IntegrationsController, OrgIntegrationsController],
  providers: [
    {
      provide: TallyClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<IntegrationEnv, true>) =>
        new TallyClient(config.get('TALLY_API_BASE_URL', { infer: true }), config.get('PROVIDER_HTTP_TIMEOUT_MS', { infer: true })),
    },
    TallyProviderAdapter,
    {
      provide: FORM_PROVIDER_ADAPTERS,
      inject: [TallyProviderAdapter],
      useFactory: (tally: TallyProviderAdapter): FormProviderAdapter[] => [tally],
    },
    ProviderRegistry,
    IntegrationsService,
  ],
  exports: [IntegrationsService, ProviderRegistry],
})
export class IntegrationModule {}

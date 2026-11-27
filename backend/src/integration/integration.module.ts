import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';
import { IntegrationsController, OrgIntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { JotformClient } from './providers/jotform/jotform.client';
import { JotformProviderAdapter } from './providers/jotform/jotform.provider';
import { FORM_PROVIDER_ADAPTERS, ProviderRegistry } from './providers/provider.registry';
import { TallyClient } from './providers/tally/tally.client';
import { TallyProviderAdapter } from './providers/tally/tally.provider';
import { TypeformClient } from './providers/typeform/typeform.client';
import { TypeformProviderAdapter } from './providers/typeform/typeform.provider';
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
      provide: TypeformClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<IntegrationEnv, true>) =>
        new TypeformClient(config.get('TYPEFORM_API_BASE_URL', { infer: true }), config.get('PROVIDER_HTTP_TIMEOUT_MS', { infer: true })),
    },
    TypeformProviderAdapter,
    {
      provide: JotformClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<IntegrationEnv, true>) =>
        new JotformClient(
          [config.get('JOTFORM_API_BASE_URL', { infer: true }), config.get('JOTFORM_EU_API_BASE_URL', { infer: true })],
          config.get('PROVIDER_HTTP_TIMEOUT_MS', { infer: true }),
        ),
    },
    JotformProviderAdapter,
    {
      provide: FORM_PROVIDER_ADAPTERS,
      inject: [TallyProviderAdapter, TypeformProviderAdapter, JotformProviderAdapter],
      useFactory: (
        tally: TallyProviderAdapter,
        typeform: TypeformProviderAdapter,
        jotform: JotformProviderAdapter,
      ): FormProviderAdapter[] => [tally, typeform, jotform],
    },
    ProviderRegistry,
    IntegrationsService,
  ],
  exports: [IntegrationsService, ProviderRegistry],
})
export class IntegrationModule {}

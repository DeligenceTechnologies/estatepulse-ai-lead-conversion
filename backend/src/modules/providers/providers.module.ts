import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FORM_PROVIDER_ADAPTERS, ProviderRegistry } from './provider.registry';
import { TallyClient } from './tally/tally.client';
import { TallyProviderAdapter } from './tally/tally.provider';
import { TypeformClient } from './typeform/typeform.client';
import { TypeformProviderAdapter } from './typeform/typeform.provider';
import type { FormProviderAdapter } from './types';

/**
 * Adding a provider: implement FormProviderAdapter, then add it to the array in
 * the FORM_PROVIDER_ADAPTERS factory below. Nothing else in this module changes.
 */
@Module({
  providers: [
    {
      provide: TallyClient,
      useFactory: (config: ConfigService) =>
        new TallyClient(
          // Overridable so the whole connect flow can be exercised against
          // scripts/fake-tally.mjs — including the failure paths a real account
          // will not produce on demand.
          config.get<string>('TALLY_API_BASE_URL') ?? 'https://api.tally.so',
          Number(config.get<string>('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000),
        ),
      inject: [ConfigService],
    },
    TallyProviderAdapter,
    {
      provide: TypeformClient,
      useFactory: (config: ConfigService) =>
        new TypeformClient(
          config.get<string>('TYPEFORM_API_BASE_URL') ?? 'https://api.typeform.com',
          Number(config.get<string>('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000),
        ),
      inject: [ConfigService],
    },
    TypeformProviderAdapter,
    {
      provide: FORM_PROVIDER_ADAPTERS,
      useFactory: (tally: TallyProviderAdapter, typeform: TypeformProviderAdapter): FormProviderAdapter[] => [
        tally,
        typeform,
      ],
      inject: [TallyProviderAdapter, TypeformProviderAdapter],
    },
    ProviderRegistry,
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}

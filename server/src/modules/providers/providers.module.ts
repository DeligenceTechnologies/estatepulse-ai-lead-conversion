import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FORM_PROVIDER_ADAPTERS, ProviderRegistry } from './provider.registry';
import { TallyClient } from './tally/tally.client';
import { TallyProviderAdapter } from './tally/tally.provider';
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
      provide: FORM_PROVIDER_ADAPTERS,
      useFactory: (tally: TallyProviderAdapter): FormProviderAdapter[] => [tally],
      inject: [TallyProviderAdapter],
    },
    ProviderRegistry,
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}

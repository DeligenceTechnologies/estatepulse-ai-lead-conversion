import { Inject, Injectable } from '@nestjs/common';
import { INTEGRATION_ADAPTERS } from '../integrations.constants';
import type { IntegrationAdapter } from './adapter.interface';

/** The providers EstatePulse implements, looked up by Nango provider name. */
@Injectable()
export class AdapterRegistry {
  private readonly byProvider: ReadonlyMap<string, IntegrationAdapter>;

  constructor(@Inject(INTEGRATION_ADAPTERS) adapters: IntegrationAdapter[]) {
    const map = new Map<string, IntegrationAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.provider)) throw new Error(`Two integration adapters claim provider "${adapter.provider}"`);
      map.set(adapter.provider, adapter);
    }
    this.byProvider = map;
  }

  get(provider: string): IntegrationAdapter | null {
    return this.byProvider.get(provider) ?? null;
  }

  all(): IntegrationAdapter[] {
    return [...this.byProvider.values()];
  }
}

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { FormProviderAdapter, ProviderCapabilities } from './types';

export const FORM_PROVIDER_ADAPTERS = Symbol('FORM_PROVIDER_ADAPTERS');

@Injectable()
export class ProviderRegistry {
  private readonly byCode = new Map<string, FormProviderAdapter>();

  constructor(@Inject(FORM_PROVIDER_ADAPTERS) adapters: FormProviderAdapter[]) {
    for (const a of adapters) this.byCode.set(a.provider.toUpperCase(), a);
  }

  get(code: string): FormProviderAdapter {
    const found = this.byCode.get((code ?? '').toUpperCase());
    if (!found) {
      throw new BadRequestException({
        error: {
          code: 'PROVIDER_UNSUPPORTED',
          message: `No integration for "${code}". Supported: ${[...this.byCode.keys()].join(', ')}.`,
        },
      });
    }
    return found;
  }

  has(code: string): boolean {
    return this.byCode.has((code ?? '').toUpperCase());
  }

  list(): { code: string; displayName: string; capabilities: ProviderCapabilities }[] {
    return [...this.byCode.values()].map((a) => ({
      code: a.provider,
      displayName: a.displayName,
      capabilities: a.capabilities,
    }));
  }
}

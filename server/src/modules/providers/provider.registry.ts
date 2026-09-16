import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { FormProviderAdapter, ProviderCapabilities } from './types';

export const FORM_PROVIDER_ADAPTERS = Symbol('FORM_PROVIDER_ADAPTERS');

/**
 * Resolves a provider code to its adapter.
 *
 * The point of this indirection is that adding Typeform is a new file plus one
 * line in providers.module.ts, with no `if (provider === 'tally')` anywhere in
 * the services. Be honest about the remaining cost though: a second provider
 * also needs its own payload-parsing IngestAdapter, its own ingest route, and a
 * signature verifier — `evaluateSignature` currently hardcodes Tally's. That
 * last one is on the ingest hot path and is deliberately not generalised yet.
 */
@Injectable()
export class ProviderRegistry {
  private readonly byCode = new Map<string, FormProviderAdapter>();

  constructor(@Inject(FORM_PROVIDER_ADAPTERS) adapters: FormProviderAdapter[]) {
    for (const a of adapters) this.byCode.set(a.provider.toUpperCase(), a);
  }

  /** Throws rather than returning undefined: every caller would only rethrow. */
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

  /** Drives GET /v1/providers, so the UI ships no provider-specific copy. */
  list(): { code: string; displayName: string; capabilities: ProviderCapabilities }[] {
    return [...this.byCode.values()].map((a) => ({
      code: a.provider,
      displayName: a.displayName,
      capabilities: a.capabilities,
    }));
  }
}

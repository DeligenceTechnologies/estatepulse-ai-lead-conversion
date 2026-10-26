import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HubSpotClient } from './hubspot/hubspot.client';
import type { CrmAdapter } from './types';

/**
 * The CRMs this build can connect, by the slug that appears in their routes
 * (`/api/integrations/crm/hubspot/...`). Each is switched on separately —
 * `HUBSPOT_ENABLED=1` — like Google Sheets: switched off, its routes answer 404
 * and nothing syncs, and switching it off changes no data.
 */
@Injectable()
export class CrmRegistry {
  private readonly bySlug: Map<string, CrmAdapter>;

  constructor(
    hubspot: HubSpotClient,
    private readonly config: ConfigService,
  ) {
    this.bySlug = new Map<string, CrmAdapter>([['hubspot', hubspot]]);
  }

  enabled(adapter: CrmAdapter): boolean {
    return this.config.get<string>(`${adapter.provider}_ENABLED`) === '1';
  }

  /** Every adapter switched on in this deployment. */
  active(): CrmAdapter[] {
    return [...this.bySlug.values()].filter((a) => this.enabled(a));
  }

  byProvider(provider: string): CrmAdapter | undefined {
    return [...this.bySlug.values()].find((a) => a.provider === provider);
  }

  /** An unknown slug and a switched-off CRM look the same from outside: not here. */
  get(slug: string): CrmAdapter {
    const adapter = this.bySlug.get(slug);
    if (!adapter || !this.enabled(adapter)) {
      throw new HttpException({ error: { code: 'CRM_NOT_AVAILABLE', message: 'That CRM integration is not enabled on this server.' } }, 404);
    }
    return adapter;
  }
}

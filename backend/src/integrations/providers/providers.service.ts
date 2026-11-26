import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ApiProvider, ApiPublicIntegration } from '@nangohq/node';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AdapterRegistry } from '../adapters/adapter.registry';
import type { IntegrationAdapter } from '../adapters/adapter.interface';
import { CATEGORY_LABELS } from '../integrations.constants';
import type {
  MarketplaceCategory,
  MarketplaceList,
  MarketplaceProvider,
  MarketplaceProviderDetail,
  ProviderConnectionSummary,
  ProviderReadiness,
} from '../integrations.types';
import { NangoService } from '../nango/nango.service';

export interface ProviderQuery {
  search?: string;
  category?: string;
  /** connected: has a live account. not_connected: has none. supported: EstatePulse implements it. */
  status?: 'all' | 'connected' | 'not_connected' | 'supported';
  limit: number;
  offset: number;
}

/** What one provider is, before the organization's own connections are counted in. */
interface ProviderFacts {
  catalog: ApiProvider | null;
  adapter: IntegrationAdapter | null;
  integration: ApiPublicIntegration | null;
}

/** The integration this server connects through when Nango has several for one provider. */
export function pickIntegration(provider: string, configs: ApiPublicIntegration[]): ApiPublicIntegration | null {
  const candidates = configs.filter((c) => c.provider === provider);
  return (
    candidates.find((c) => c.unique_key === provider && !c.missing_fields?.length) ??
    candidates.find((c) => !c.missing_fields?.length) ??
    candidates[0] ??
    null
  );
}

export const categoryLabel = (id: string): string =>
  CATEGORY_LABELS[id] ?? id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The marketplace: Nango's catalog, joined with what our Nango environment has
 * configured, what EstatePulse implements (adapters) and what this organization
 * connected. Nothing here is hardcoded per provider: a provider appears because
 * Nango lists it, becomes connectable because it is configured AND an adapter
 * exists, and shows accounts because rows exist.
 */
@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(
    private readonly nango: NangoService,
    private readonly adapters: AdapterRegistry,
    private readonly prisma: PrismaService,
  ) {}

  async list(orgId: string, query: ProviderQuery): Promise<MarketplaceList> {
    const { facts, catalogAvailable } = await this.loadFacts();
    const counts = await this.connectionCounts(orgId);
    const views = facts.map((f) => this.view(f, counts.get(this.idOf(f)) ?? { live: 0, attention: 0 }));
    let all = views;

    const search = query.search?.trim().toLowerCase();
    if (search) {
      all = all.filter(
        (p) =>
          p.id.toLowerCase().includes(search) ||
          p.name.toLowerCase().includes(search) ||
          (p.description ?? '').toLowerCase().includes(search) ||
          p.categories.some((c) => c.includes(search) || categoryLabel(c).toLowerCase().includes(search)),
      );
    }
    if (query.status === 'connected') all = all.filter((p) => p.connectionCount > 0);
    else if (query.status === 'not_connected') all = all.filter((p) => p.connectionCount === 0);
    else if (query.status === 'supported') all = all.filter((p) => p.supported);

    // Categories are counted after search and status but before the category filter, so each
    // chip says how many it would show.
    const categories = this.categoryFacets(all);
    if (query.category && query.category !== 'all') all = all.filter((p) => p.categories.includes(query.category!));

    all = [...all].sort(compareProviders);
    return {
      nango: { configured: this.nango.configured, webhooksConfigured: this.nango.webhooksConfigured, catalogAvailable },
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
      limit: query.limit,
      offset: query.offset,
      categories,
      counts: {
        catalog: facts.length,
        supported: views.filter((v) => v.supported).length,
        ready: views.filter((v) => v.readiness === 'ready').length,
        connectedProviders: views.filter((v) => v.connectionCount > 0).length,
        connectedAccounts: [...counts.values()].reduce((sum, c) => sum + c.live, 0),
      },
    };
  }

  async detail(orgId: string, providerId: string): Promise<Omit<MarketplaceProviderDetail, 'connections'>> {
    const facts = await this.factsFor(providerId);
    const counts = await this.connectionCounts(orgId);
    const view = this.view(facts, counts.get(providerId) ?? { live: 0, attention: 0 });
    return {
      ...view,
      requiredScopes: [...(facts.adapter?.requiredScopes ?? [])],
      missingFields: facts.integration?.missing_fields ?? [],
    };
  }

  /**
   * What a connect for `providerId` needs: the adapter and the Nango integration key.
   * Throws a customer-readable error when the provider is not connectable.
   */
  async connectable(providerId: string): Promise<{ adapter: IntegrationAdapter; integration: ApiPublicIntegration }> {
    const facts = await this.factsFor(providerId);
    const { readiness, message } = readinessOf(facts, this.nango.configured);
    if (readiness !== 'ready' || !facts.adapter || !facts.integration) {
      throw new ProviderNotReadyError(message ?? 'This integration cannot be connected yet.', readiness);
    }
    return { adapter: facts.adapter, integration: facts.integration };
  }

  /** The integration a Nango providerConfigKey belongs to, only if it is one of ours with an adapter. */
  async integrationByKey(providerConfigKey: string): Promise<{ adapter: IntegrationAdapter; integration: ApiPublicIntegration } | null> {
    const configs = await this.nango.listConfigured();
    const integration = configs.find((c) => c.unique_key === providerConfigKey);
    const adapter = integration ? this.adapters.get(integration.provider) : null;
    return integration && adapter ? { adapter, integration } : null;
  }

  /** Display name and logo for a provider, best effort (the catalog may be unreachable). */
  async displayOf(provider: string): Promise<{ name: string; logoUrl: string | null }> {
    const adapter = this.adapters.get(provider);
    if (this.nango.configured) {
      try {
        const hit = await this.nango.catalogProvider(provider);
        if (hit) return { name: hit.display_name, logoUrl: hit.logo_url || null };
      } catch {
        /* fall through to the adapter's name */
      }
    }
    return { name: adapter?.displayName ?? provider, logoUrl: null };
  }

  private async factsFor(providerId: string): Promise<ProviderFacts> {
    const { facts } = await this.loadFacts();
    const hit = facts.find((f) => this.idOf(f) === providerId);
    if (!hit) throw new NotFoundException('That integration does not exist.');
    return hit;
  }

  /**
   * Every provider the marketplace can show. Without Nango (no key, or Nango down with
   * nothing cached) only the providers EstatePulse implements are listed, each marked as
   * needing configuration — never a made-up catalog.
   */
  private async loadFacts(): Promise<{ facts: ProviderFacts[]; catalogAvailable: boolean }> {
    let catalog: ApiProvider[] = [];
    let configs: ApiPublicIntegration[] = [];
    let catalogAvailable = false;
    if (this.nango.configured) {
      const [c, i] = await Promise.allSettled([this.nango.listCatalog(), this.nango.listConfigured()]);
      if (c.status === 'fulfilled') {
        catalog = c.value;
        catalogAvailable = true;
      } else this.logger.warn(`Nango catalog unavailable: ${(c.reason as Error).message}`);
      if (i.status === 'fulfilled') configs = i.value;
      else this.logger.warn(`Nango integrations unavailable: ${(i.reason as Error).message}`);
    }

    const facts: ProviderFacts[] = catalog.map((p) => ({
      catalog: p,
      adapter: this.adapters.get(p.name),
      integration: pickIntegration(p.name, configs),
    }));
    // An adapter whose provider the catalog did not return (catalog unreachable) still shows.
    for (const adapter of this.adapters.all()) {
      if (!facts.some((f) => f.catalog?.name === adapter.provider)) {
        facts.push({ catalog: null, adapter, integration: pickIntegration(adapter.provider, configs) });
      }
    }
    return { facts, catalogAvailable };
  }

  private idOf(f: ProviderFacts): string {
    return f.catalog?.name ?? f.adapter!.provider;
  }

  private view(f: ProviderFacts, count: { live: number; attention: number }): MarketplaceProvider {
    const { readiness, message } = readinessOf(f, this.nango.configured);
    const summary: ProviderConnectionSummary = count.attention > 0 ? 'attention' : count.live > 0 ? 'connected' : 'not_connected';
    return {
      id: this.idOf(f),
      name: f.catalog?.display_name ?? f.adapter?.displayName ?? this.idOf(f),
      logoUrl: f.catalog?.logo_url || null,
      categories: [...(f.catalog?.categories?.length ? f.catalog.categories : (f.adapter?.fallbackCategories ?? ['other']))],
      authMode: f.catalog?.auth_mode ?? null,
      docsUrl: f.catalog?.docs ?? null,
      description: f.adapter?.description ?? null,
      features: [...(f.adapter?.features ?? [])],
      capabilities: [...(f.adapter?.capabilities ?? [])],
      supported: Boolean(f.adapter),
      configured: Boolean(f.integration),
      readiness,
      readinessMessage: message,
      connectionCount: count.live,
      connectionSummary: summary,
    };
  }

  /** Live accounts per provider (everything but disconnected), and how many need attention. */
  private async connectionCounts(orgId: string): Promise<Map<string, { live: number; attention: number }>> {
    const rows = await this.prisma.integrationConnection.groupBy({
      by: ['provider', 'status'],
      where: { orgId, status: { not: 'disconnected' } },
      _count: { _all: true },
    });
    const out = new Map<string, { live: number; attention: number }>();
    for (const r of rows) {
      const c = out.get(r.provider) ?? { live: 0, attention: 0 };
      c.live += r._count._all;
      if (r.status !== 'connected') c.attention += r._count._all;
      out.set(r.provider, c);
    }
    return out;
  }

  private categoryFacets(items: MarketplaceProvider[]): MarketplaceCategory[] {
    const counts = new Map<string, number>();
    for (const p of items) for (const c of p.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, label: categoryLabel(id), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
}

export class ProviderNotReadyError extends Error {
  constructor(
    message: string,
    readonly readiness: ProviderReadiness,
  ) {
    super(message);
  }
}

function readinessOf(f: ProviderFacts, nangoConfigured: boolean): { readiness: ProviderReadiness; message: string | null } {
  if (!f.adapter) {
    return {
      readiness: 'unsupported',
      message: f.integration
        ? 'Set up in Nango, but EstatePulse does not support this integration yet.'
        : 'EstatePulse does not support this integration yet.',
    };
  }
  if (!nangoConfigured) {
    return { readiness: 'configuration_required', message: 'Integrations are not configured on this server yet (Nango API key missing).' };
  }
  if (!f.integration) {
    return { readiness: 'configuration_required', message: `${f.adapter.displayName} has not been set up in Nango yet. Ask your administrator to add it.` };
  }
  if (f.integration.missing_fields?.length) {
    return { readiness: 'configuration_required', message: `${f.adapter.displayName} is missing configuration in Nango (${f.integration.missing_fields.join(', ')}).` };
  }
  return { readiness: 'ready', message: null };
}

const READINESS_ORDER: Record<ProviderReadiness, number> = { ready: 0, configuration_required: 1, unsupported: 2 };

/** Connected first, then what can be connected, then what needs setup, then the rest of the catalog. */
function compareProviders(a: MarketplaceProvider, b: MarketplaceProvider): number {
  return (
    Number(b.connectionCount > 0) - Number(a.connectionCount > 0) ||
    READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness] ||
    a.name.localeCompare(b.name)
  );
}

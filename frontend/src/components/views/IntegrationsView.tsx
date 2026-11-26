import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Blocks, PlugZap, RefreshCw, SearchX, Sparkles } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { integrationsApi, type MarketplaceList, type MarketplaceProvider, type ProviderQuery } from '../../utils/integrationsApi';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { Notice, SearchField } from '../calendar/shared/ui';
import { ProviderCard, ProviderCardSkeleton } from '../integrations/marketplace/ProviderCard';
import { ProviderDetailsModal } from '../integrations/marketplace/ProviderDetailsModal';
import { useNangoConnect, type ConnectOutcome } from '../integrations/marketplace/useNangoConnect';

const PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 300;
/** Shown as chips when the catalog has them; every other category is in the "More" menu. */
const FEATURED_CATEGORIES = ['crm', 'marketing', 'productivity', 'communication', 'storage', 'automation', 'other'];

type StatusFilter = NonNullable<ProviderQuery['status']>;
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'not_connected', label: 'Not connected' },
  { id: 'supported', label: 'Supported' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const Stat: React.FC<{ value: number | null; label: string }> = ({ value, label }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-2.5 min-w-[7.5rem]">
    <div className="text-lg font-bold text-white tabular-nums leading-tight">{value ?? '—'}</div>
    <div className="text-2xs text-slate-500">{label}</div>
  </div>
);

const chip = (active: boolean) =>
  `h-8 px-3 rounded-full text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 ${
    active ? 'bg-brand-500/15 text-brand-200 border-brand-500/40' : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
  }`;

/**
 * The Integration Marketplace. Every provider shown comes from the backend,
 * which reads Nango's catalog; this page holds no list of its own.
 */
export const IntegrationsView: React.FC = () => {
  const { can } = useAuth();
  const canEdit = can('integration.update');
  const [params, setParams] = useSearchParams();
  const openId = params.get('integration');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const [data, setData] = useState<MarketplaceList | null>(null);
  const [items, setItems] = useState<MarketplaceProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const requestId = useRef(0);

  const { connect, reconnect, busyKey } = useNangoConnect();

  const query = useMemo<ProviderQuery>(
    () => ({ search: debouncedSearch.trim() || undefined, category, status, limit: PAGE_SIZE }),
    [debouncedSearch, category, status],
  );

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await integrationsApi.listProviders({ ...query, offset: 0 });
      if (id !== requestId.current) return;
      setData(res);
      setItems(res.items);
    } catch (e) {
      if (id === requestId.current) setError(messageFor(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!data || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const res = await integrationsApi.listProviders({ ...query, offset: items.length });
      if (id !== requestId.current) return;
      setItems((prev) => [...prev, ...res.items.filter((p) => !prev.some((x) => x.id === p.id))]);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const labels = useMemo(() => new Map((data?.categories ?? []).map((c) => [c.id, c.label])), [data]);
  const categoryLabel = useCallback(
    (id: string) => labels.get(id) ?? id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    [labels],
  );
  const featured = (data?.categories ?? []).filter((c) => FEATURED_CATEGORIES.includes(c.id));
  const featuredSorted = FEATURED_CATEGORIES.map((id) => featured.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const more = (data?.categories ?? []).filter((c) => !FEATURED_CATEGORIES.includes(c.id));

  const open = (providerId: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set('integration', providerId);
    return next;
  });
  const close = () => setParams((p) => {
    const next = new URLSearchParams(p);
    next.delete('integration');
    return next;
  });

  const afterConnect = (outcome: ConnectOutcome, providerId: string | null) => {
    switch (outcome.kind) {
      case 'connected':
        toast.success(
          outcome.connection.setup && !outcome.connection.setup.complete
            ? `${outcome.connection.providerName} connected. Finish the setup to start importing.`
            : `${outcome.connection.providerName} connected.`,
        );
        if (providerId) open(providerId);
        break;
      case 'pending':
        toast.info(outcome.message);
        // The webhook links it shortly; look again then.
        window.setTimeout(() => {
          void load();
          setDetailRefresh((n) => n + 1);
        }, 5_000);
        break;
      case 'failed':
        toast.error(outcome.message);
        break;
      case 'cancelled':
        break;
    }
    void load();
    setDetailRefresh((n) => n + 1);
  };

  const startConnect = async (providerId: string) => afterConnect(await connect(providerId), providerId);
  const startReconnect = async (connectionId: string) => {
    const outcome = await reconnect(connectionId);
    if (outcome.kind === 'connected') toast.success(`${outcome.connection.providerName} reconnected.`);
    else afterConnect(outcome, null);
    void load();
    setDetailRefresh((n) => n + 1);
  };

  const filtered = Boolean(debouncedSearch.trim()) || category !== 'all' || status !== 'all';
  const clearFilters = () => {
    setSearch('');
    setCategory('all');
    setStatus('all');
  };

  return (
    <div className="p-6 max-w-7xl mx-auto text-slate-100 space-y-6">
      {/* Header */}
      <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="w-11 h-11 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-300 flex items-center justify-center shrink-0">
            <Blocks className="w-5 h-5" />
          </span>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Integrations</h2>
            <p className="text-xs text-slate-400 mt-0.5">Connect your favorite tools and bring your workflows together.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Stat value={data?.counts.connectedAccounts ?? null} label="Connected accounts" />
          <Stat value={data?.counts.ready ?? null} label="Ready to connect" />
          <Stat value={data?.counts.catalog ?? null} label="Available" />
        </div>
      </header>

      {data && !data.nango.configured && (
        <Notice tone="warning">
          Integrations are not configured on this server yet, so nothing can be connected. An administrator needs to add the Nango
          API key (NANGO_SECRET_KEY); see docs/INTEGRATIONS.md.
        </Notice>
      )}
      {data && data.nango.configured && !data.nango.catalogAvailable && (
        <Notice tone="info">Nango’s catalog could not be reached, so only the integrations EstatePulse supports are listed. Try again shortly.</Notice>
      )}

      {/* Toolbar */}
      <div className="space-y-3">
        <div className="flex flex-col md:flex-row md:items-center gap-3 md:justify-between">
          <SearchField value={search} onChange={setSearch} placeholder="Search by name, category or description" />
          <div className="inline-flex p-0.5 rounded-lg border border-slate-800 bg-slate-900/60 self-start" role="tablist" aria-label="Connection status">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={status === f.id}
                onClick={() => setStatus(f.id)}
                className={`h-7 px-3 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                  status === f.id ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {data && (data.categories.length > 0 || category !== 'all') && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Categories">
            <button type="button" className={chip(category === 'all')} onClick={() => setCategory('all')}>
              All
            </button>
            {featuredSorted.map((c) => (
              <button key={c.id} type="button" className={chip(category === c.id)} onClick={() => setCategory(c.id)}>
                {c.label} <span className="text-slate-500 ml-0.5">{c.count}</span>
              </button>
            ))}
            {more.length > 0 && (
              <div className="w-48">
                <Select
                  aria-label="More categories"
                  value={more.some((c) => c.id === category) ? category : ''}
                  onChange={(e) => setCategory(e.target.value || 'all')}
                >
                  <option value="">More categories…</option>
                  {more.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ({c.count})
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      {error && !loading ? (
        <div role="alert" className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-8 text-center space-y-3">
          <AlertTriangle className="w-6 h-6 text-rose-400 mx-auto" />
          <div className="text-sm font-semibold text-rose-100">Integrations could not be loaded</div>
          <p className="text-xs text-rose-200/80">{error}</p>
          <Button variant="danger-soft" size="sm" icon={<RefreshCw />} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : loading && !items.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy aria-label="Loading integrations">
          {Array.from({ length: 8 }, (_, i) => (
            <ProviderCardSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-10 text-center space-y-3">
          {filtered ? <SearchX className="w-6 h-6 text-slate-500 mx-auto" /> : <PlugZap className="w-6 h-6 text-slate-500 mx-auto" />}
          <div className="text-sm font-semibold text-slate-200">{filtered ? 'No integrations match' : 'No integrations available'}</div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {filtered
              ? status === 'connected'
                ? 'Nothing connected matches these filters yet.'
                : 'Try another search term or category.'
              : 'Once Nango is configured, every integration it supports appears here.'}
          </p>
          {filtered && (
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {items.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                categoryLabel={categoryLabel}
                canConnect={canEdit}
                connecting={busyKey === `connect:${p.id}`}
                connectBlocked={busyKey !== null}
                onOpen={() => open(p.id)}
                onConnect={() => void startConnect(p.id)}
              />
            ))}
          </div>
          <div className="flex flex-col items-center gap-2 pt-2">
            <span className="text-2xs text-slate-500">
              Showing {items.length} of {data?.total ?? items.length}
            </span>
            {data && items.length < data.total && (
              <Button variant="secondary" size="sm" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            )}
          </div>
        </>
      )}

      {data && data.counts.supported > 0 && !filtered && (
        <p className="text-2xs text-slate-500 flex items-center gap-1.5 justify-center">
          <Sparkles className="w-3 h-3" /> {data.counts.supported} integration{data.counts.supported === 1 ? ' is' : 's are'} fully supported by EstatePulse; the rest of
          Nango’s catalog is listed so you can see what is coming.
        </p>
      )}

      {openId && (
        <ProviderDetailsModal
          key={openId}
          providerId={openId}
          categoryLabel={categoryLabel}
          canEdit={canEdit}
          busyKey={busyKey}
          refreshKey={detailRefresh}
          onConnect={(id) => void startConnect(id)}
          onReconnect={(id) => void startReconnect(id)}
          onChanged={() => void load()}
          onClose={close}
        />
      )}
    </div>
  );
};

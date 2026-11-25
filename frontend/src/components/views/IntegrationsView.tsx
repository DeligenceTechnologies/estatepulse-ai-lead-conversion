import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Lightbulb, Loader2, Plug, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { connectProvider, listConnections, type ConnectionCategory, type ProviderView } from '../../utils/connectionsApi';
import { ConnectionDrawer } from '../connections/ConnectionDrawer';
import { ConnectionTile, accountLine, tileState } from '../connections/ConnectionTile';
import { CATEGORIES, WEBHOOK_TILE, type TileKey } from '../connections/providerMeta';

type Filter = 'all' | 'connected' | ConnectionCategory;

const isTile = (v: string | null): v is TileKey =>
  v !== null && ['google', 'airtable', 'hubspot', 'typeform', 'tally', 'calendly', 'cal', 'telnyx', 'webhook'].includes(v);

/**
 * Connections: every outside account the organization uses, on one page.
 * Each provider is the same tile — status, account, one action — and the same
 * drawer: its accounts, then its own setup. Connecting is one flow for all of
 * them (Nango Connect); see utils/connectionsApi.
 */
export const IntegrationsView: React.FC = () => {
  const { can } = useAuth();
  const canEdit = can('integration.update');
  const [params, setParams] = useSearchParams();
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<TileKey | null>(null);

  // The open drawer lives in the URL (?manage=telnyx), so Settings and emails can link straight to it.
  const open = isTile(params.get('manage')) ? (params.get('manage') as TileKey) : null;
  const setOpen = useCallback(
    (tile: TileKey | null) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          if (tile) next.set('manage', tile);
          else next.delete('manage');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const load = useCallback(async () => {
    try {
      setProviders(await listConnections());
      setError(null);
    } catch (e) {
      setError(messageFor(e));
      setProviders((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (provider: ProviderView, reconnectId?: string) => {
    if (busy) return;
    setBusy(provider.key);
    try {
      const linked = await connectProvider(provider.key, { reconnectId });
      if (!linked) return;
      toast.success(reconnectId ? `${provider.label} reconnected.` : `${provider.label} connected.`);
      await load();
      // A fresh account usually has setup to do (pick a sheet, a number, a team): open it.
      if (!reconnectId) setOpen(provider.key);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const byKey = useMemo(() => new Map((providers ?? []).map((p) => [p.key, p])), [providers]);
  const total = providers?.length ?? 0;
  const connectedCount = (providers ?? []).filter((p) => p.connections.length > 0).length;
  const brokenCount = (providers ?? []).filter((p) => p.connections.some((c) => c.state === 'broken')).length;

  const matches = (label: string, description: string, category: ConnectionCategory, connected: boolean) => {
    if (filter === 'connected' && !connected) return false;
    if (filter !== 'all' && filter !== 'connected' && filter !== category) return false;
    const q = query.trim().toLowerCase();
    return !q || label.toLowerCase().includes(q) || description.toLowerCase().includes(q);
  };

  const filters: { id: Filter; label: string; count?: number }[] = [
    { id: 'all', label: 'All' },
    { id: 'connected', label: 'Connected', count: connectedCount },
    ...CATEGORIES.map((c) => ({ id: c.id as Filter, label: c.label })),
  ];

  const openProvider = open && open !== 'webhook' ? (byKey.get(open) ?? null) : null;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto text-slate-100 space-y-6">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950/60 p-6 sm:p-8 shadow-2xl">
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full bg-indigo-500/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/3 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div className="max-w-xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-400/25 bg-indigo-500/10 px-3 py-1 text-2xs font-semibold text-indigo-200">
              <Plug className="w-3.5 h-3.5" /> Connections
            </div>
            <h2 className="mt-3 text-2xl sm:text-3xl font-bold text-white tracking-tight">Your apps, connected in one place</h2>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Bring in leads, sync your CRM, let leads book meetings and call from your own numbers. Every account connects the same
              secure way.
            </p>
            <p className="mt-3 inline-flex items-center gap-1.5 text-2xs text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Passwords and API keys never touch EstatePulse; they stay in an
              encrypted credential vault.
            </p>
          </div>

          <div className="flex items-stretch gap-3">
            <div className="rounded-2xl border border-slate-700/80 bg-slate-950/50 backdrop-blur px-5 py-4 min-w-36">
              <div className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">Connected</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-white tabular-nums">{providers ? connectedCount : '–'}</span>
                <span className="text-sm text-slate-500">of {total || '–'}</span>
              </div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-500"
                  style={{ width: total ? `${(connectedCount / total) * 100}%` : '0%' }}
                />
              </div>
            </div>
            {brokenCount > 0 && (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 min-w-36">
                <div className="text-2xs uppercase tracking-wider text-rose-300 font-semibold">Needs attention</div>
                <div className="mt-1 text-3xl font-bold text-rose-100 tabular-nums">{brokenCount}</div>
                <div className="mt-1 text-2xs text-rose-200/80">Reconnect to resume</div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Filters */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div role="tablist" aria-label="Filter connections" className="flex gap-1.5 overflow-x-auto pb-1 -mb-1 custom-scrollbar">
          {filters.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold border transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                filter === f.id
                  ? 'bg-white text-slate-950 border-white shadow'
                  : 'bg-slate-900/80 text-slate-300 border-slate-800 hover:border-slate-600 hover:text-white'
              }`}
            >
              {f.label}
              {f.count !== undefined && (
                <span className={`ml-1.5 tabular-nums ${filter === f.id ? 'text-slate-500' : 'text-slate-500'}`}>{f.count}</span>
              )}
            </button>
          ))}
        </div>
        <label className="relative md:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="w-full rounded-full border border-slate-800 bg-slate-900/80 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-px" />
          <div className="flex-1 text-rose-100">
            <div className="font-semibold">Couldn't load your connections</div>
            <div className="text-rose-200/80">{error}</div>
          </div>
          <button onClick={() => void load()} className="inline-flex items-center gap-1 text-rose-200 hover:text-white font-semibold cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}

      {providers === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-52 rounded-2xl border border-slate-800 bg-slate-900/60 animate-pulse" />
          ))}
          <span className="sr-only">
            <Loader2 /> Loading connections
          </span>
        </div>
      ) : (
        CATEGORIES.map((category) => {
          const tiles = providers.filter(
            (p) => p.category === category.id && matches(p.label, p.description, p.category, p.connections.length > 0),
          );
          const showWebhook =
            category.id === 'leads' && filter !== 'connected' && matches(WEBHOOK_TILE.label, WEBHOOK_TILE.description, 'leads', false);
          if (tiles.length === 0 && !showWebhook) return null;
          const Icon = category.icon;
          return (
            <section key={category.id} className="space-y-3">
              <div className="flex items-center gap-2.5">
                <span className="w-7 h-7 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 flex items-center justify-center">
                  <Icon className="w-3.5 h-3.5" />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-white">{category.label}</h3>
                  <p className="text-2xs text-slate-500">{category.hint}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {tiles.map((p) => (
                  <ConnectionTile
                    key={p.key}
                    tile={p.key}
                    label={p.label}
                    description={p.description}
                    state={tileState(p.connections, p.unavailable)}
                    account={accountLine(p.connections)}
                    unavailable={p.unavailable}
                    busy={busy === p.key}
                    canEdit={canEdit}
                    onConnect={() => void connect(p)}
                    onReconnect={() => {
                      const broken = p.connections.find((c) => c.state === 'broken');
                      void connect(p, broken?.id);
                    }}
                    onManage={() => setOpen(p.key)}
                  />
                ))}
                {showWebhook && (
                  <ConnectionTile
                    tile="webhook"
                    label={WEBHOOK_TILE.label}
                    description={WEBHOOK_TILE.description}
                    state="idle"
                    account={null}
                    unavailable={null}
                    busy={false}
                    canEdit={canEdit}
                    setupOnly
                    onConnect={() => setOpen('webhook')}
                    onReconnect={() => setOpen('webhook')}
                    onManage={() => setOpen('webhook')}
                  />
                )}
              </div>
            </section>
          );
        })
      )}

      {/* Calling hours follow each lead's own time zone, so a field for it helps. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-xs">
        <Lightbulb className="w-4 h-4 text-sky-300 shrink-0 mt-px" />
        <p className="text-slate-300">
          <span className="font-semibold text-white">Tip:</span> add a <span className="font-semibold text-white">Time Zone</span> field to
          your form or sheet. We call and text in each lead's local time; without it we guess from the phone number. New leads show up in{' '}
          <span className="font-semibold text-white">Lead Sources</span>.
        </p>
      </div>

      {open && (
        <ConnectionDrawer
          tile={open}
          provider={openProvider}
          label={open === 'webhook' ? WEBHOOK_TILE.label : (openProvider?.label ?? '')}
          description={open === 'webhook' ? WEBHOOK_TILE.description : (openProvider?.description ?? '')}
          canEdit={canEdit}
          busy={busy !== null}
          onConnect={() => openProvider && void connect(openProvider)}
          onReconnect={(id) => openProvider && void connect(openProvider, id)}
          onChanged={() => void load()}
          onClose={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </div>
  );
};

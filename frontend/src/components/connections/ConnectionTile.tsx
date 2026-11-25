import React from 'react';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Loader2, Lock, Plus, RefreshCw, Settings2, Wrench } from 'lucide-react';
import type { ConnectionView } from '../../utils/connectionsApi';
import { BRANDS, type TileKey } from './providerMeta';

export type TileState = 'idle' | 'connected' | 'needs_setup' | 'broken' | 'unavailable';

/** One state for the tile, from its accounts: a broken one wins, then one waiting for setup. */
export function tileState(connections: ConnectionView[], unavailable: string | null): TileState {
  if (connections.some((c) => c.state === 'broken')) return 'broken';
  if (connections.some((c) => c.state === 'needs_setup')) return 'needs_setup';
  if (connections.length > 0) return 'connected';
  return unavailable ? 'unavailable' : 'idle';
}

const BADGE: Record<TileState, { label: string; className: string; icon: React.ReactNode }> = {
  connected: {
    label: 'Connected',
    className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  needs_setup: {
    label: 'Finish setup',
    className: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
    icon: <Wrench className="w-3 h-3" />,
  },
  broken: {
    label: 'Reconnect needed',
    className: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  unavailable: {
    label: 'Unavailable',
    className: 'bg-slate-500/10 text-slate-400 border-slate-500/25',
    icon: <Lock className="w-3 h-3" />,
  },
  idle: {
    label: 'Not connected',
    className: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    icon: <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />,
  },
};

export const BrandMark: React.FC<{ tile: TileKey; size?: 'md' | 'lg' }> = ({ tile, size = 'md' }) => {
  const brand = BRANDS[tile];
  const box = size === 'lg' ? 'w-12 h-12 text-base rounded-2xl' : 'w-10 h-10 text-sm rounded-xl';
  return (
    <span
      aria-hidden
      className={`${box} shrink-0 bg-gradient-to-br ${brand.gradient} text-white font-black tracking-tight flex items-center justify-center shadow-lg ring-1 ring-white/10`}
    >
      {brand.mark}
    </span>
  );
};

export const StatusBadge: React.FC<{ state: TileState }> = ({ state }) => {
  const b = BADGE[state];
  return (
    <span className={`text-2xs font-semibold px-2.5 py-1 rounded-full border inline-flex items-center gap-1.5 whitespace-nowrap ${b.className}`}>
      {b.icon}
      {b.label}
    </span>
  );
};

/** Who is connected, in one line: an email, a name, a masked key — or how many accounts. */
export function accountLine(connections: ConnectionView[]): string | null {
  if (connections.length === 0) return null;
  const first = connections[0];
  const who = first.accountEmail || first.accountName || first.label || (first.preview && first.preview !== 'oauth' ? first.preview : null);
  if (connections.length === 1) return who;
  return `${who ?? 'Account'} + ${connections.length - 1} more`;
}

export const ConnectionTile: React.FC<{
  tile: TileKey;
  label: string;
  description: string;
  state: TileState;
  account: string | null;
  unavailable: string | null;
  busy: boolean;
  canEdit: boolean;
  /** Not an account (the webhook): only Manage. */
  setupOnly?: boolean;
  onConnect: () => void;
  onReconnect: () => void;
  onManage: () => void;
}> = ({ tile, label, description, state, account, unavailable, busy, canEdit, setupOnly, onConnect, onReconnect, onManage }) => {
  const brand = BRANDS[tile];
  const live = state === 'connected' || state === 'needs_setup';

  const primary = (() => {
    if (setupOnly) return { label: 'Set up', icon: <Settings2 className="w-4 h-4" />, onClick: onManage, tone: 'primary' as const };
    if (state === 'broken') return { label: 'Reconnect', icon: <RefreshCw className="w-4 h-4" />, onClick: onReconnect, tone: 'danger' as const };
    if (state === 'needs_setup') return { label: 'Finish setup', icon: <Wrench className="w-4 h-4" />, onClick: onManage, tone: 'warn' as const };
    if (state === 'connected') return { label: 'Manage', icon: <Settings2 className="w-4 h-4" />, onClick: onManage, tone: 'quiet' as const };
    return { label: 'Connect', icon: <Plus className="w-4 h-4" />, onClick: onConnect, tone: 'primary' as const };
  })();

  const tone = {
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white border-transparent shadow-lg shadow-indigo-900/30',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white border-transparent shadow-lg shadow-rose-900/30',
    warn: 'bg-amber-500 hover:bg-amber-400 text-slate-950 border-transparent shadow-lg shadow-amber-900/30',
    quiet: 'bg-slate-800/70 hover:bg-slate-700/80 text-slate-100 border-slate-700',
  }[primary.tone];

  const disabled = busy || (!setupOnly && state === 'unavailable') || (!canEdit && primary.label !== 'Manage');

  return (
    <article
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-b from-slate-900 to-slate-950 p-5 flex flex-col gap-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-2xl ${
        live ? `border-slate-700 ring-1 ${brand.ring} shadow-xl ${brand.glow}` : state === 'broken' ? 'border-rose-500/40 shadow-xl' : 'border-slate-800 shadow-lg'
      } ${state === 'unavailable' ? 'opacity-70' : ''}`}
    >
      {/* A wash of the brand colour in the corner: the tile reads as that provider before the name does. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -top-16 -right-16 w-40 h-40 rounded-full bg-gradient-to-br ${brand.gradient} blur-3xl transition-opacity duration-300 ${
          live ? 'opacity-25' : 'opacity-[0.07] group-hover:opacity-15'
        }`}
      />

      <div className="relative flex items-start justify-between gap-3">
        <BrandMark tile={tile} />
        <StatusBadge state={state} />
      </div>

      <div className="relative min-w-0 flex-1">
        <h3 className="text-[15px] font-bold text-white tracking-tight">{label}</h3>
        <p className="text-xs text-slate-400 leading-relaxed mt-1 line-clamp-2">{description}</p>
        {account && (
          <p className="mt-3 text-2xs text-slate-300 truncate flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state === 'broken' ? 'bg-rose-400' : 'bg-emerald-400'}`} />
            {account}
          </p>
        )}
        {state === 'unavailable' && unavailable && <p className="mt-3 text-2xs text-slate-500 leading-relaxed">{unavailable}</p>}
      </div>

      <div className="relative flex items-center gap-2">
        <button
          type="button"
          onClick={primary.onClick}
          disabled={disabled}
          className={`flex-1 inline-flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${tone}`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : primary.icon}
          {primary.label}
        </button>
        {/* A broken or unfinished connection still has its settings one click away. */}
        {(state === 'broken' || state === 'needs_setup') && !setupOnly && (
          <button
            type="button"
            onClick={onManage}
            aria-label={`Manage ${label}`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800/70 hover:bg-slate-700/80 text-slate-200 w-9 h-9 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <ArrowUpRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </article>
  );
};

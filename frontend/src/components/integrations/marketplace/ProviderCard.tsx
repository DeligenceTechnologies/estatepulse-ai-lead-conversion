import React from 'react';
import { ArrowUpRight, Plus, Settings2 } from 'lucide-react';
import { Button } from '../../common/Button';
import type { MarketplaceProvider } from '../../../utils/integrationsApi';
import { ProviderLogo, ProviderStatusBadge } from './parts';

/** Fixed-height card, so the grid stays even whatever the copy length. */
export const ProviderCard: React.FC<{
  provider: MarketplaceProvider;
  categoryLabel: (id: string) => string;
  canConnect: boolean;
  connecting: boolean;
  /** True while another connect window is open: this card's Connect waits. */
  connectBlocked: boolean;
  onOpen: () => void;
  onConnect: () => void;
}> = ({ provider, categoryLabel, canConnect, connecting, connectBlocked, onOpen, onConnect }) => {
  const connected = provider.connectionCount > 0;
  const description =
    provider.description ??
    (provider.readiness === 'unsupported'
      ? 'Available through Nango. EstatePulse does not support it yet.'
      : 'Available through Nango.');

  return (
    <article
      className={`group relative h-full min-h-[13.5rem] flex flex-col rounded-2xl border bg-slate-900/80 p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-slate-700 focus-within:border-slate-700 ${
        provider.connectionSummary === 'attention'
          ? 'border-amber-500/30'
          : connected
            ? 'border-emerald-500/25'
            : 'border-slate-800'
      }`}
    >
      {/* The whole card opens the details; the buttons below sit above this layer. */}
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 rounded-2xl cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
        aria-label={`${provider.name} details`}
      />

      <div className="flex items-start justify-between gap-3">
        <ProviderLogo name={provider.name} logoUrl={provider.logoUrl} />
        <ProviderStatusBadge provider={provider} />
      </div>

      <div className="mt-3 min-w-0">
        <h3 className="text-sm font-bold text-white truncate">{provider.name}</h3>
        <div className="mt-0.5 text-2xs text-slate-500 truncate">
          {provider.categories.slice(0, 2).map(categoryLabel).join(' · ')}
        </div>
        <p className="mt-2 text-xs text-slate-400 leading-relaxed line-clamp-2">{description}</p>
      </div>

      <div className="relative mt-auto pt-4 flex items-center justify-between gap-2">
        <span className="text-2xs text-slate-500">
          {connected ? `${provider.connectionCount} account${provider.connectionCount === 1 ? '' : 's'} connected` : ' '}
        </span>
        {connected ? (
          <Button size="sm" variant="secondary" icon={<Settings2 />} onClick={onOpen}>
            Manage
          </Button>
        ) : provider.readiness === 'ready' && canConnect ? (
          <Button size="sm" icon={<Plus />} onClick={onConnect} loading={connecting} disabled={connectBlocked && !connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" iconRight={<ArrowUpRight />} onClick={onOpen}>
            Details
          </Button>
        )}
      </div>
    </article>
  );
};

export const ProviderCardSkeleton: React.FC = () => (
  <div className="h-full min-h-[13.5rem] rounded-2xl border border-slate-800 bg-slate-900/60 p-4 animate-pulse" aria-hidden>
    <div className="flex items-start justify-between">
      <div className="w-11 h-11 rounded-xl bg-slate-800" />
      <div className="w-20 h-5 rounded-full bg-slate-800" />
    </div>
    <div className="mt-4 h-4 w-28 rounded bg-slate-800" />
    <div className="mt-2 h-3 w-16 rounded bg-slate-800/70" />
    <div className="mt-3 space-y-1.5">
      <div className="h-3 w-full rounded bg-slate-800/60" />
      <div className="h-3 w-4/5 rounded bg-slate-800/60" />
    </div>
    <div className="mt-6 flex justify-end">
      <div className="h-8 w-24 rounded-lg bg-slate-800" />
    </div>
  </div>
);

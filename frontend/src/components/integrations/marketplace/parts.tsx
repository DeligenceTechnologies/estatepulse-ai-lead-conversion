import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Lock, Settings2, Unplug } from 'lucide-react';
import type {
  ConnectionStatus,
  IntegrationConnection,
  MarketplaceProvider,
  SyncRun,
} from '../../../utils/integrationsApi';
import { isSyncActive } from '../../../utils/integrationsApi';

/**
 * The provider's logo from Nango's catalog. When there is none (catalog
 * unreachable) or it fails to load, its initials — never a guessed image.
 */
export const ProviderLogo: React.FC<{ name: string; logoUrl: string | null; size?: 'sm' | 'md' | 'lg' }> = ({
  name,
  logoUrl,
  size = 'md',
}) => {
  const [failed, setFailed] = useState(false);
  const box = { sm: 'w-8 h-8 rounded-lg', md: 'w-11 h-11 rounded-xl', lg: 'w-14 h-14 rounded-2xl' }[size];
  const img = { sm: 'w-5 h-5', md: 'w-7 h-7', lg: 'w-9 h-9' }[size];
  const initials = name
    .split(/[\s.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span className={`${box} shrink-0 flex items-center justify-center bg-white border border-slate-700/60 shadow-sm overflow-hidden`}>
      {logoUrl && !failed ? (
        <img
          src={logoUrl}
          alt=""
          className={`${img} object-contain`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-xs font-bold text-slate-700" aria-hidden>
          {initials || '?'}
        </span>
      )}
    </span>
  );
};

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'brand';

const TONES: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  warning: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  danger: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  neutral: 'bg-slate-800/80 text-slate-400 border-slate-700',
  info: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
  brand: 'bg-brand-500/10 text-brand-300 border-brand-500/25',
};

export const Badge: React.FC<{ tone: Tone; icon?: React.ReactNode; children: React.ReactNode; title?: string }> = ({
  tone,
  icon,
  children,
  title,
}) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${TONES[tone]}`}
  >
    {icon}
    {children}
  </span>
);

const ico = 'w-3 h-3';

/** The card's one status: what the organization has, else whether it can be connected. */
export const ProviderStatusBadge: React.FC<{ provider: MarketplaceProvider }> = ({ provider }) => {
  if (provider.connectionSummary === 'attention') {
    return (
      <Badge tone="warning" icon={<AlertTriangle className={ico} />}>
        Needs attention
      </Badge>
    );
  }
  if (provider.connectionCount > 0) {
    return (
      <Badge tone="success" icon={<CheckCircle2 className={ico} />}>
        {provider.connectionCount === 1 ? 'Connected' : `${provider.connectionCount} accounts`}
      </Badge>
    );
  }
  if (provider.readiness === 'ready') {
    return (
      <Badge tone="brand" icon={<CircleDashed className={ico} />}>
        Ready to connect
      </Badge>
    );
  }
  if (provider.readiness === 'configuration_required') {
    return (
      <Badge tone="neutral" icon={<Settings2 className={ico} />} title={provider.readinessMessage ?? undefined}>
        Configuration required
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" icon={<Lock className={ico} />} title={provider.readinessMessage ?? undefined}>
      Not yet supported
    </Badge>
  );
};

const CONNECTION_LABEL: Record<ConnectionStatus, { tone: Tone; label: string }> = {
  connected: { tone: 'success', label: 'Connected' },
  reauth_required: { tone: 'warning', label: 'Reauthorization required' },
  error: { tone: 'danger', label: 'Error' },
  disconnected: { tone: 'neutral', label: 'Disconnected' },
};

/** One account's state, with an active sync taking precedence over "Connected". */
export const ConnectionStatusBadge: React.FC<{ connection: IntegrationConnection }> = ({ connection }) => {
  if (connection.status === 'connected' && isSyncActive(connection.latestRun)) {
    return (
      <Badge tone="info" icon={<Loader2 className={`${ico} animate-spin`} />}>
        {connection.latestRun?.status === 'queued' ? 'Sync queued' : 'Syncing'}
      </Badge>
    );
  }
  if (connection.status === 'connected' && connection.setup && !connection.setup.complete) {
    return (
      <Badge tone="warning" icon={<Settings2 className={ico} />}>
        Setup needed
      </Badge>
    );
  }
  const { tone, label } = CONNECTION_LABEL[connection.status];
  const icon =
    connection.status === 'connected' ? (
      <CheckCircle2 className={ico} />
    ) : connection.status === 'disconnected' ? (
      <Unplug className={ico} />
    ) : (
      <AlertTriangle className={ico} />
    );
  return (
    <Badge tone={tone} icon={icon}>
      {label}
    </Badge>
  );
};

/** "3 new, 12 unchanged" — the parts of a finished run worth saying. */
export function describeRun(run: SyncRun): string {
  const s = run.stats;
  const parts = [
    s.created && `${s.created} new`,
    s.attached && `${s.attached} matched existing`,
    s.unchanged && `${s.unchanged} unchanged`,
    s.skipped && `${s.skipped} without contact details`,
    s.failed && `${s.failed} failed`,
  ].filter(Boolean);
  if (!parts.length) return s.fetched ? `${s.fetched} read, nothing new` : 'No records found';
  return `${parts.join(', ')}${s.truncated ? ' (stopped at the per-sync limit)' : ''}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

import React from 'react';
import { AlertTriangle, CalendarCheck, CalendarClock, CheckCircle2, Info, Loader2, Search, X } from 'lucide-react';
import type { CalendarProviderId, PoolingType, WorkspaceRole, WorkspaceType } from '../../../utils/calendarApi';

export const PROVIDERS: Record<
  CalendarProviderId,
  {
    label: string;
    tagline: string;
    icon: React.ElementType;
    tone: string;
    selected: string;
    button: string;
    focus: string;
  }
> = {
  calendly: {
    label: 'Calendly',
    tagline: 'Sign in with Calendly. Works for a solo owner or a whole organization.',
    icon: CalendarCheck,
    tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    selected: 'border-sky-500/60 bg-sky-500/[0.06]',
    button: 'bg-sky-600 hover:bg-sky-500 focus-visible:ring-sky-400',
    focus: 'focus:border-sky-500',
  },
  cal: {
    label: 'Cal.com',
    tagline: 'Paste an API key. Works with a personal account or a Cal.com team.',
    icon: CalendarClock,
    tone: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    selected: 'border-indigo-500/60 bg-indigo-500/[0.06]',
    button: 'bg-indigo-600 hover:bg-indigo-500 focus-visible:ring-indigo-400',
    focus: 'focus:border-indigo-500',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as CalendarProviderId[];

export const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export const WORKSPACE_LABEL: Record<WorkspaceType, string> = {
  organization: 'Organization',
  team: 'Team',
  personal: 'Personal account',
};

export const POOLING_LABEL: Record<PoolingType, string> = {
  round_robin: 'Round robin',
  collective: 'Collective',
  managed: 'Managed',
  multi_pool: 'Multi-pool',
};

export const panel = 'bg-slate-950/60 border border-slate-800 rounded-xl';

const NOTICE_STYLES = {
  error: { box: 'bg-rose-500/10 border-rose-500/30 text-rose-200', icon: AlertTriangle },
  warning: { box: 'bg-amber-500/10 border-amber-500/30 text-amber-200', icon: AlertTriangle },
  success: { box: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200', icon: CheckCircle2 },
  info: { box: 'bg-slate-800/60 border-slate-700 text-slate-300', icon: Info },
} as const;

export type NoticeTone = keyof typeof NOTICE_STYLES;

export const Notice: React.FC<{ tone: NoticeTone; children: React.ReactNode; onDismiss?: () => void }> = ({
  tone,
  children,
  onDismiss,
}) => {
  const { box, icon: Icon } = NOTICE_STYLES[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`border rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs leading-relaxed ${box}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 break-words">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="p-0.5 -m-0.5 rounded opacity-70 hover:opacity-100 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};

export const ProviderBadge: React.FC<{ id: CalendarProviderId; size?: 'sm' | 'md' }> = ({ id, size = 'md' }) => {
  const { icon: Icon, tone } = PROVIDERS[id];
  return (
    <span
      className={`${size === 'sm' ? 'w-8 h-8' : 'w-10 h-10'} rounded-xl border flex items-center justify-center shrink-0 ${tone}`}
    >
      <Icon className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} />
    </span>
  );
};

export const PrimaryButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  className: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ onClick, disabled, busy, className, icon, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={`h-9 px-4 rounded-lg text-xs font-semibold text-on-accent inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
  >
    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
    {children}
  </button>
);

export const SecondaryButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ onClick, disabled, danger, icon, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`h-8 px-3 rounded-lg text-xs font-semibold border inline-flex items-center gap-1.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-50 disabled:cursor-not-allowed ${
      danger
        ? 'text-rose-100 bg-rose-500/15 border-rose-500/40 hover:bg-rose-500/25'
        : 'text-slate-300 border-slate-700 hover:border-slate-600 hover:text-white'
    }`}
  >
    {icon}
    {children}
  </button>
);

export const StatusPill: React.FC<{ tone: 'neutral' | 'success' | 'warning'; spinning?: boolean; children: React.ReactNode }> = ({
  tone,
  spinning,
  children,
}) => {
  const styles = {
    neutral: { pill: 'bg-slate-800 text-slate-400', dot: 'bg-slate-500' },
    success: { pill: 'bg-emerald-500/10 text-emerald-300', dot: 'bg-emerald-400' },
    warning: { pill: 'bg-amber-500/10 text-amber-300', dot: 'bg-amber-400' },
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${styles.pill}`}
    >
      {spinning ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />}
      {children}
    </span>
  );
};

export const SearchField: React.FC<{ value: string; onChange: (value: string) => void; placeholder: string }> = ({
  value,
  onChange,
  placeholder,
}) => (
  <div className="relative w-full sm:max-w-xs">
    <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      maxLength={100}
      className="h-9 w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-8 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 [&::-webkit-search-cancel-button]:hidden"
    />
    {value && (
      <button
        type="button"
        onClick={() => onChange('')}
        aria-label="Clear search"
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-500 hover:text-slate-200 cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    )}
  </div>
);

export const Empty: React.FC<{ icon: React.ElementType; title: string; children: React.ReactNode }> = ({
  icon: Icon,
  title,
  children,
}) => (
  <div className="flex flex-col items-center text-center px-4 py-10">
    <span className="w-11 h-11 rounded-2xl bg-slate-950 border border-slate-800 text-slate-500 flex items-center justify-center mb-3">
      <Icon className="w-5 h-5" />
    </span>
    <div className="text-xs font-bold text-slate-200">{title}</div>
    <p className="text-2xs text-slate-500 mt-1 max-w-sm leading-relaxed">{children}</p>
  </div>
);

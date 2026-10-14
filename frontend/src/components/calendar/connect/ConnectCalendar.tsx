import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, ArrowRight, CalendarClock, CalendarDays, ShieldAlert, Unlink } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { messageFor } from '../../../lib/api';
import {
  disconnectOrganizationCalendar,
  getOrganizationCalendar,
  type CalendarConnection,
  type CalendarProviderId,
  type OrganizationCalendarStatus,
} from '../../../utils/calendarApi';
import { CalComConnect } from './CalComConnect';
import { CalendlyConnect } from './CalendlyConnect';
import { ConnectFlow } from './ConnectFlow';
import {
  Notice,
  PROVIDERS,
  ProviderBadge,
  ROLE_LABEL,
  SecondaryButton,
  StatusPill,
  WORKSPACE_LABEL,
  panel,
  type NoticeTone,
} from '../shared/ui';

type Flash = { tone: NoticeTone; text: string };

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const Fact: React.FC<{ label: string; value: string | null }> = ({ label, value }) => (
  <div className="min-w-0">
    <dt className="text-2xs uppercase tracking-wide text-slate-500">{label}</dt>
    <dd className="text-xs text-slate-200 truncate mt-0.5" title={value ?? undefined}>
      {value || '—'}
    </dd>
  </div>
);

const LoadingState: React.FC = () => (
  <div className="space-y-3 animate-pulse" aria-busy>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="h-20 rounded-xl bg-slate-800/60" />
      <div className="h-20 rounded-xl bg-slate-800/60" />
    </div>
    <div className="h-28 rounded-xl bg-slate-800/40" />
  </div>
);

const ConnectionSummary: React.FC<{
  provider: CalendarProviderId;
  connection: CalendarConnection;
  canEdit: boolean;
  onReconnected: () => Promise<boolean>;
  onSwitch: () => void;
  onDisconnected: () => Promise<void>;
}> = ({ provider, connection, canEdit, onReconnected, onSwitch, onDisconnected }) => {
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const broken = connection.status === 'error';
  const { label } = PROVIDERS[provider];

  const disconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      await disconnectOrganizationCalendar();
      await onDisconnected();
    } catch (e) {
      setError(messageFor(e));
      setDisconnecting(false);
    }
  };

  return (
    <div className={`${panel} p-4 space-y-4`}>
      <div className="flex items-center gap-3">
        <ProviderBadge id={provider} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-white">{label}</div>
          <div className="text-xs text-slate-400 truncate">{connection.accountEmail ?? connection.accountName ?? '—'}</div>
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Fact label="Account" value={connection.accountName} />
        <Fact
          label={connection.workspaceType === 'team' ? 'Team' : 'Type'}
          value={connection.workspaceName ?? WORKSPACE_LABEL[connection.workspaceType]}
        />
        <Fact label="Your role" value={connection.workspaceRole ? ROLE_LABEL[connection.workspaceRole] : null} />
        <Fact label="Connected" value={formatDate(connection.connectedAt)} />
      </dl>

      {broken && (
        <Notice tone="warning">
          {connection.lastError ?? `${label} stopped accepting this connection. Reconnect to resume.`}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {canEdit && broken && (
        <div className="pt-1">
          {provider === 'calendly' ? (
            <CalendlyConnect onConnected={onReconnected} reconnect />
          ) : (
            <CalComConnect onConnected={onReconnected} reconnect />
          )}
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800">
          <SecondaryButton onClick={onSwitch} disabled={disconnecting} icon={<ArrowLeftRight className="w-3.5 h-3.5" />}>
            Change calendar
          </SecondaryButton>
          {confirming ? (
            <>
              <span className="text-2xs text-slate-400">Disconnect {label}?</span>
              <SecondaryButton
                danger
                onClick={() => void disconnect()}
                disabled={disconnecting}
                icon={<Unlink className="w-3.5 h-3.5" />}
              >
                {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
              </SecondaryButton>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={disconnecting}
                className="h-8 px-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                Cancel
              </button>
            </>
          ) : (
            <SecondaryButton onClick={() => setConfirming(true)} icon={<Unlink className="w-3.5 h-3.5" />}>
              Disconnect
            </SecondaryButton>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Where the connected calendar is put to work. Settings only connects; team
 * availability, meeting types and members are the sidebar's Calendar pages.
 */
const CalendarPagesLink: React.FC<{ providerLabel: string }> = ({ providerLabel }) => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/team-availability')}
      className="group w-full text-left bg-emerald-500/[0.06] border border-emerald-500/25 hover:border-emerald-500/50 rounded-xl p-4 flex items-center gap-3 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
    >
      <span className="w-9 h-9 rounded-lg bg-emerald-500/15 text-emerald-300 flex items-center justify-center shrink-0">
        <CalendarClock className="w-4 h-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-white">{providerLabel} is ready</span>
        <span className="block text-2xs text-slate-400 mt-0.5">See availability, meetings and members under Calendar.</span>
      </span>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 shrink-0">
        <span className="hidden sm:inline">Open Calendar</span>
        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
};

export const ConnectCalendar: React.FC = () => {
  const { can } = useAuth();
  const canEdit = can('organization.update');
  const [params, setParams] = useSearchParams();

  const [status, setStatus] = useState<OrganizationCalendarStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [switching, setSwitching] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const load = useCallback(async () => {
    try {
      setStatus(await getOrganizationCalendar());
      setLoadError(null);
    } catch (e) {
      setLoadError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const outcome = params.get('calendar');
    if (!outcome) return;
    setFlash(
      outcome === 'connected'
        ? { tone: 'success', text: 'Calendly connected.' }
        : { tone: 'error', text: 'Calendly was not connected. Please try again.' },
    );
    const next = new URLSearchParams(params);
    next.delete('calendar');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const refreshAfterConnect = useCallback(async (): Promise<boolean> => {
    const connectionKey = (value: OrganizationCalendarStatus | null) =>
      value?.provider && value.connection ? `${value.provider}:${value.connection.connectedAt}` : null;
    const before = connectionKey(statusRef.current);
    try {
      const next = await getOrganizationCalendar();
      setStatus(next);
      setLoadError(null);
      const connected = next.connection?.status === 'active' && connectionKey(next) !== before;
      if (connected && next.provider) {
        setFlash({ tone: 'success', text: `${PROVIDERS[next.provider].label} connected.` });
        setSwitching(false);
      }
      return connected;
    } catch (e) {
      setLoadError(messageFor(e));
      return false;
    }
  }, []);

  const afterDisconnect = useCallback(async () => {
    const label = statusRef.current?.provider ? PROVIDERS[statusRef.current.provider].label : 'Calendar';
    await load();
    setFlash({ tone: 'info', text: `${label} disconnected.` });
  }, [load]);

  const provider = status?.provider ?? null;
  const connection = status?.connection ?? null;

  const pill = !status ? (
    <StatusPill tone="neutral" spinning>
      Checking
    </StatusPill>
  ) : connection?.status === 'error' ? (
    <StatusPill tone="warning">Needs attention</StatusPill>
  ) : connection ? (
    <StatusPill tone="success">Connected</StatusPill>
  ) : (
    <StatusPill tone="neutral">Not connected</StatusPill>
  );

  let body: React.ReactNode;
  if (loadError && !status) {
    body = (
      <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
        <div className="text-xs text-rose-200 leading-relaxed flex-1">
          <div className="font-semibold text-rose-100">Calendar status could not be loaded</div>
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-100 bg-rose-500/20 hover:bg-rose-500/30 cursor-pointer transition-colors"
        >
          Retry
        </button>
      </div>
    );
  } else if (!status) {
    body = <LoadingState />;
  } else if (!provider || !connection) {
    body = canEdit ? (
      <ConnectFlow
        status={status}
        initial={status.providers.find((entry) => entry.saved)?.id ?? 'calendly'}
        onConnected={refreshAfterConnect}
      />
    ) : (
      <div className={`${panel} p-4 text-xs text-slate-400 flex items-start gap-2`}>
        <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
        No calendar is connected yet. Connecting one needs the “Edit organization settings” permission.
      </div>
    );
  } else if (switching) {
    body = (
      <ConnectFlow
        status={status}
        initial={provider === 'calendly' ? 'cal' : 'calendly'}
        onConnected={refreshAfterConnect}
        onCancel={() => setSwitching(false)}
      />
    );
  } else {
    body = (
      <div className="space-y-4">
        <ConnectionSummary
          provider={provider}
          connection={connection}
          canEdit={canEdit}
          onReconnected={refreshAfterConnect}
          onSwitch={() => setSwitching(true)}
          onDisconnected={afterDisconnect}
        />
        {connection.status === 'active' && <CalendarPagesLink providerLabel={PROVIDERS[provider].label} />}
      </div>
    );
  }

  return (
    <section className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
        <div className="flex items-start gap-3 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
            <CalendarDays className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white">Scheduling calendar</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Connect Calendly or Cal.com. One calendar at a time.
            </p>
          </div>
        </div>
        {pill}
      </header>

      <div className="p-5 space-y-4">
        {flash && (
          <Notice tone={flash.tone} onDismiss={() => setFlash(null)}>
            {flash.text}
          </Notice>
        )}
        {loadError && status && <Notice tone="error">{loadError}</Notice>}
        {body}
      </div>
    </section>
  );
};

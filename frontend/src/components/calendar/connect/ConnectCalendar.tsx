import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, ArrowRight, CalendarDays, ShieldAlert, Unlink } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../../context/AuthContext';
import { messageFor } from '../../../lib/api';
import {
  announceCalendlyResult,
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
} from '../shared/ui';
import { formatDate } from '../../../lib/datetime';
// Explicit .tsx: on case-insensitive disks '../meetings/Meetings' resolves to the sibling meetings.ts helpers.
import { Meetings } from '../meetings/Meetings.tsx';
import { SyncButton } from '../shared/SyncButton';

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
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const broken = connection.status === 'error';
  const { label } = PROVIDERS[provider];

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectOrganizationCalendar();
      await onDisconnected();
    } catch (e) {
      toast.error(messageFor(e));
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

      {canEdit && broken && (
        <div className="pt-1">
          {provider === 'calendly' ? (
            <CalendlyConnect onConnected={onReconnected} reconnect />
          ) : (
            <CalComConnect onConnected={onReconnected} reconnect />
          )}
        </div>
      )}

      {(canEdit || !broken) && (
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800">
          {canEdit && (
            <>
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
            </>
          )}
          {/* Settings only connects; availability and meetings live under Calendar in the sidebar. */}
          {!broken && !confirming && (
            <button
              type="button"
              onClick={() => navigate('/team-availability')}
              className="group ml-auto h-8 px-3 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-on-accent inline-flex items-center gap-1.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Open Calendar
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const ConnectCalendar: React.FC = () => {
  const { can } = useAuth();
  const canEdit = can('organization.update');
  const [params, setParams] = useSearchParams();

  const [status, setStatus] = useState<OrganizationCalendarStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  /** Bumped by the Sync button; Meetings reloads when it changes. */
  const [syncVersion, setSyncVersion] = useState(0);
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
    // Calendly severs window.opener, so its callback lands the popup here.
    // Report to the tab that opened it, then close (a no-op in an ordinary tab).
    announceCalendlyResult(outcome === 'connected');
    window.close();
    // toastId: StrictMode runs this effect twice before the param is cleared.
    if (outcome === 'connected') toast.success('Calendly connected.', { toastId: 'calendly-return' });
    else toast.error('Calendly was not connected. Please try again.', { toastId: 'calendly-return' });
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
        toast.success(`${PROVIDERS[next.provider].label} connected.`);
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
    toast.success(`${label} disconnected.`);
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
      </div>
    );
  }

  // What the connected calendar has booked lives here, next to the connection
  // it is read from, rather than as its own page.
  const showMeetings = Boolean(provider && connection?.status === 'active' && !switching);

  return (
    <div className="space-y-5">
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
          {loadError && status && <Notice tone="error">{loadError}</Notice>}
          {body}
        </div>
      </section>

      {showMeetings && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <SyncButton
              providerLabel={PROVIDERS[provider!].label}
              initialSyncedAt={connection?.syncedAt ?? null}
              onSynced={() => setSyncVersion((version) => version + 1)}
            />
          </div>
          {/* Keyed by connection so switching calendars never shows the old provider's rows. */}
          <Meetings key={connection!.connectedAt} provider={provider!} syncVersion={syncVersion} />
        </div>
      )}
    </div>
  );
};

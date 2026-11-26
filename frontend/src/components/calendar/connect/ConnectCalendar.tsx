import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CalendarDays, Unlink } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../../context/AuthContext';
import { messageFor } from '../../../lib/api';
import {
  disconnectOrganizationCalendar,
  getOrganizationCalendar,
  type CalendarConnection,
  type CalendarProviderId,
  type OrganizationCalendarStatus,
} from '../../../utils/calendarApi';
import { Button } from '../../common/Button';
import {
  Notice,
  PROVIDERS,
  ProviderBadge,
  ROLE_LABEL,
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
  onDisconnected: () => Promise<void>;
}> = ({ provider, connection, canEdit, onDisconnected }) => {
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

      {(canEdit || !broken) && (
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800">
          {canEdit && (
            <>
              {confirming ? (
                <>
                  <span className="text-2xs text-slate-400">Disconnect {label}?</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void disconnect()}
                    loading={disconnecting}
                    icon={<Unlink />}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={disconnecting}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="danger-soft" size="sm" onClick={() => setConfirming(true)} icon={<Unlink />}>
                  Disconnect
                </Button>
              )}
            </>
          )}
          {/* Settings only connects; availability and meetings live under Calendar in the sidebar. */}
          {!broken && !confirming && (
            <Button
              size="sm"
              onClick={() => navigate('/team-availability')}
              iconRight={<ArrowRight />}
              className="ml-auto"
            >
              Open Calendar
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export const ConnectCalendar: React.FC = () => {
  const { can } = useAuth();
  const canEdit = can('organization.update');

  const [status, setStatus] = useState<OrganizationCalendarStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        <Button variant="danger-soft" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  } else if (!status) {
    body = <LoadingState />;
  } else if (!provider || !connection) {
    body = <div className={`${panel} p-4 text-xs text-slate-400`}>No calendar is connected yet.</div>;
  } else {
    body = <ConnectionSummary provider={provider} connection={connection} canEdit={canEdit} onDisconnected={afterDisconnect} />;
  }

  // What the connected calendar has booked lives here, next to the connection
  // it is read from, rather than as its own page.
  const showMeetings = Boolean(provider && connection?.status === 'active');

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
              <p className="text-xs text-slate-400 mt-0.5">Calendly or Cal.com. One calendar at a time.</p>
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

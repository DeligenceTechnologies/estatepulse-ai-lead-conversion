import React, { useState } from 'react';
import { AlertTriangle, KeyRound, RefreshCw, Settings2, Unlink } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, isSyncActive, type IntegrationConnection } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { AirtableSetup } from './AirtableSetup';
import { CalendarSetup } from './CalendarSetup';
import { HubSpotSetup } from './HubSpotSetup';
import { TallySetup } from './TallySetup';
import { TwoWaySyncPanel } from './TwoWaySyncPanel';
import { ConnectionStatusBadge, describeRun, relativeTime } from './parts';

/**
 * Provider-specific setup screens, by Nango provider name. HubSpot's is
 * optional (extra field mapping): it imports as soon as it is connected.
 */
const SETUP_PANELS: Partial<Record<string, React.FC<{ connection: IntegrationConnection; onSaved: (c: IntegrationConnection) => void; onCancel: () => void }>>> = {
  airtable: AirtableSetup,
  'cal-com-v2': CalendarSetup,
  calendly: CalendarSetup,
  hubspot: HubSpotSetup,
  tally: TallySetup,
};

/** One connected account, with everything that can be done to it. Other accounts of the provider are unaffected. */
export const ConnectionRow: React.FC<{
  connection: IntegrationConnection;
  index: number;
  canEdit: boolean;
  reconnecting: boolean;
  connectBusy: boolean;
  onReconnect: () => void;
  onChanged: () => void;
}> = ({ connection: c, index, canEdit, reconnecting, connectBusy, onReconnect, onChanged }) => {
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const Setup = SETUP_PANELS[c.provider];
  const needsSetup = Boolean(c.setup && !c.setup.complete);
  const [settingUp, setSettingUp] = useState(needsSetup && c.status === 'connected');
  const active = isSyncActive(c.latestRun);
  const broken = c.status === 'reauth_required' || c.status === 'error';

  const title = c.accountName ?? c.accountEmail ?? `${c.providerName} account ${index + 1}`;

  const sync = async () => {
    setSyncing(true);
    try {
      const { created } = await integrationsApi.sync(c.id);
      toast.info(created ? `Sync started for ${title}.` : 'A sync is already running for this account.');
      onChanged();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await integrationsApi.disconnect(c.id);
      toast.success(`${title} disconnected. Leads already imported stay in EstatePulse.`);
      onChanged();
    } catch (e) {
      toast.error(messageFor(e));
      setDisconnecting(false);
      setConfirming(false);
    }
  };

  const run = c.latestRun;
  const runLine =
    run && run.status === 'failed'
      ? { tone: 'text-rose-300', text: `Last sync failed: ${run.errorMessage ?? 'unknown error'}` }
      : run && run.status === 'succeeded'
        ? { tone: 'text-slate-400', text: `Last sync ${relativeTime(run.finishedAt)} — ${describeRun(run)}` }
        : run && active
          ? { tone: 'text-sky-300', text: run.stats.fetched ? `${run.stats.fetched} records read so far…` : run.errorMessage ?? 'Waiting for a worker…' }
          : null;

  return (
    <li className={`rounded-xl border p-4 space-y-3 ${broken ? 'border-amber-500/30 bg-amber-500/[0.03]' : 'border-slate-800 bg-slate-950/40'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-white truncate" title={title}>
              {title}
            </span>
            <ConnectionStatusBadge connection={c} />
          </div>
          <div className="mt-0.5 text-2xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
            {c.accountEmail && c.accountEmail !== title && <span>{c.accountEmail}</span>}
            {c.setup?.summary && <span>{c.setup.summary}</span>}
            <span>Connected {relativeTime(c.connectedAt)}</span>
            <span>Last synced {relativeTime(c.lastSyncedAt)}</span>
          </div>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-1.5">
            {broken && (
              <Button size="sm" icon={<KeyRound />} onClick={onReconnect} loading={reconnecting} disabled={connectBusy && !reconnecting}>
                Reconnect
              </Button>
            )}
            {Setup && c.status === 'connected' && !settingUp && (
              <Button size="sm" variant="outline" icon={<Settings2 />} onClick={() => setSettingUp(true)}>
                {needsSetup ? 'Set up' : c.provider === 'hubspot' ? 'Map fields' : 'Change'}
              </Button>
            )}
            {/* Only providers that import leads sync; Cal.com is synced by the calendar module itself. */}
            {c.status === 'connected' && !needsSetup && (c.canSync || active) && (
              <Button size="sm" variant="secondary" icon={<RefreshCw className={active ? 'animate-spin' : ''} />} onClick={() => void sync()} loading={syncing} disabled={active || !c.canSync}>
                {active ? 'Syncing' : 'Sync now'}
              </Button>
            )}
            {confirming ? (
              <>
                <Button size="sm" variant="danger" icon={<Unlink />} onClick={() => void disconnect()} loading={disconnecting}>
                  Disconnect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={disconnecting}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" icon={<Unlink />} onClick={() => setConfirming(true)} aria-label={`Disconnect ${title}`}>
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>

      {confirming && (
        <p className="text-2xs text-slate-400">
          Disconnect {title}? EstatePulse stops syncing it and Nango deletes its access. Leads already imported are kept.
        </p>
      )}

      {broken && c.lastError?.message && (
        <div className="flex items-start gap-2 text-2xs text-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{c.lastError.message}</span>
        </div>
      )}

      {!broken && needsSetup && !settingUp && c.setup?.missing && <p className="text-2xs text-amber-200">{c.setup.missing}</p>}

      {runLine && <p className={`text-2xs ${runLine.tone}`}>{runLine.text}</p>}

      {!needsSetup && <TwoWaySyncPanel connection={c} canEdit={canEdit} onChanged={onChanged} />}

      {Setup && settingUp && canEdit && c.status === 'connected' && (
        <Setup
          connection={c}
          onSaved={() => {
            setSettingUp(false);
            onChanged();
          }}
          onCancel={() => setSettingUp(false)}
        />
      )}
    </li>
  );
};

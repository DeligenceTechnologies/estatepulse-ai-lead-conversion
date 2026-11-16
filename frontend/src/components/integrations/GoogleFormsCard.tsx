import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ClipboardList, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  checkFormSource,
  connectGoogle,
  createFormSource,
  disconnectGoogle,
  formStatus,
  getGoogleFormsConfig,
  isFormsDisabled,
  listFormSources,
  listGoogleConnections,
  loadPickerLibraries,
  pauseFormSource,
  pickerReady,
  removeFormSource,
  type FormSource,
  type GoogleConnection,
  type GoogleSheetsConfig,
} from '../../utils/googleFormsApi';
import { pickDriveFile } from '../../utils/googleSheetsApi';
import { FormMappingModal } from '../googleforms/FormMappingModal';
import { FormSetupModal } from '../googleforms/FormSetupModal';
import { errorText, timeAgo } from '../sheets/SheetModal';
import { IntegrationCard } from './IntegrationCard';

/**
 * Google Forms — connect the Google account, pick a form, map its questions,
 * paste the script into the form, switch it on.
 *
 * The Google account is the SAME one the Google Sheets card connects: one
 * account per organization. Connecting it here connects it there, and this
 * card deliberately reuses that flow rather than opening a second popup.
 */

const TONE = {
  good: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  warn: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  bad: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  idle: 'bg-slate-800 text-slate-400 border-slate-700',
} as const;

const link = 'text-2xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer disabled:opacity-40';

const SourceRow: React.FC<{
  source: FormSource;
  onMap: () => void;
  onSetup: () => void;
  onChanged: () => void;
}> = ({ source, onMap, onSetup, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const st = formStatus(source);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
      toast.success(done);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-bold text-slate-100 truncate" title={source.name}>
          {source.name}
        </span>
        <span className={`text-2xs font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${TONE[st.tone]}`}>{st.label}</span>
      </div>

      <div className="text-2xs text-slate-500">
        {source.lastDeliveryAt ? `Last response ${timeAgo(source.lastDeliveryAt)}` : 'No responses yet'}
        {/* Only worth a line once it has actually done something: a recovery
            that found nothing is not news to an owner. */}
        {source.lastPollAt && ` · checked ${timeAgo(source.lastPollAt)}`}
      </div>

      {source.waiting > 0 && (
        <div className="text-2xs text-amber-300">
          {source.waiting} response{source.waiting === 1 ? '' : 's'} received during setup — they arrive when you switch the form on.
        </div>
      )}

      {source.lastErrorMessage && (
        <div className="flex items-start gap-1.5 text-2xs text-amber-300">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{source.lastErrorMessage}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
        <button type="button" className={link} onClick={onMap} disabled={busy}>
          {source.mappingStatus === 'CONFIGURED' ? 'Edit mapping' : 'Map questions'}
        </button>
        <button type="button" className={link} onClick={onSetup} disabled={busy}>
          {source.live ? 'Script & test' : 'Set up'}
        </button>
        {source.live ? (
          <>
            <button type="button" className={link} disabled={busy} onClick={() => act(() => checkFormSource(source.id), 'Checked for missed responses.')}>
              Check now
            </button>
            <button type="button" className={link} disabled={busy} onClick={() => act(() => pauseFormSource(source.id), 'Form paused.')}>
              Pause
            </button>
          </>
        ) : null}
        <button type="button" className={`${link} hover:text-rose-300`} disabled={busy} onClick={() => setConfirmRemove(true)}>
          Remove
        </button>
        {busy && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
      </div>

      {confirmRemove && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 space-y-2 text-2xs text-rose-200">
          <div>
            Remove this form? Its leads are kept. Delete the EstatePulse script in the form too, or it keeps trying to send responses to
            an address that no longer accepts them.
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              className="font-bold text-rose-300 hover:text-rose-200 cursor-pointer disabled:opacity-40"
              disabled={busy}
              onClick={() => act(() => removeFormSource(source.id), 'Form removed.')}
            >
              Remove form
            </button>
            <button type="button" className={link} disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const GoogleFormsCard: React.FC = () => {
  const [config, setConfig] = useState<GoogleSheetsConfig | null>(null);
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [sources, setSources] = useState<FormSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<null | 'connect' | 'pick' | 'disconnect'>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [mapping, setMapping] = useState<string | null>(null);
  const [setup, setSetup] = useState<FormSource | null>(null);
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, connections, list] = await Promise.all([getGoogleFormsConfig(), listGoogleConnections(), listFormSources()]);
      setConfig(cfg);
      setConnection(connections[0] ?? null);
      setSources(list);
      setError(null);
    } catch (e) {
      if (isFormsDisabled(e)) setDisabled(true);
      else setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);

  const live = connection?.status === 'ACTIVE';
  const pickerConfigured = Boolean(config?.apiKey && config?.appId);

  // Loaded ahead of the click: Google opens its window only from a gesture.
  useEffect(() => {
    if (live && pickerConfigured) void loadPickerLibraries().catch((e) => setError(errorText(e)));
  }, [live, pickerConfigured]);

  const connect = async () => {
    if (busy === 'connect') {
      pending.current?.abort();
      return;
    }
    setBusy('connect');
    const ac = new AbortController();
    pending.current = ac;
    try {
      setConnection(await connectGoogle(ac.signal));
      toast.success('Google connected.');
      await load();
    } catch (e) {
      if (!ac.signal.aborted) toast.error(errorText(e));
    } finally {
      pending.current = null;
      setBusy(null);
    }
  };

  const addForm = async () => {
    if (!config || !connection) return;
    if (!pickerReady()) {
      toast.warn('Google’s picker is still loading. Try again in a moment.');
      return;
    }
    setBusy('pick');
    try {
      const formId = await pickDriveFile(config, connection.accountEmail, 'FORMS');
      if (!formId) return;
      const created = await createFormSource({ connectionId: connection.id, formId });
      await load();
      // Straight into mapping: the questions are already read, and a form
      // nobody maps does nothing.
      setMapping(created.id);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy('disconnect');
    try {
      await disconnectGoogle(connection.id);
      setArmed(false);
      await load();
      toast.success('Google disconnected.');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const action = !config?.configured
    ? { label: 'Not configured on this server', icon: <X className="w-3.5 h-3.5" />, onClick: () => undefined, className: 'bg-slate-800 text-slate-500 cursor-default' }
    : busy === 'connect'
      ? { label: 'Waiting for Google… (cancel)', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, onClick: connect, className: 'bg-slate-800 text-slate-300 hover:bg-slate-700' }
      : !connection || !live
        ? {
            label: connection ? 'Reconnect Google' : 'Connect Google',
            icon: connection ? <RefreshCw className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />,
            onClick: connect,
            className: 'bg-green-600 text-white hover:bg-green-500',
          }
        : {
            label: busy === 'pick' ? 'Choose a form in Google…' : 'Add a form',
            icon: busy === 'pick' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />,
            onClick: pickerConfigured && busy !== 'pick' ? addForm : () => undefined,
            className: pickerConfigured ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : 'bg-slate-800 text-slate-500 cursor-default',
          };

  // Switched off on this server (GOOGLE_FORMS_ENABLED): no card at all.
  if (disabled) return null;

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-violet-600/20 text-violet-300 flex items-center justify-center border border-violet-500/30 shrink-0">
            <ClipboardList className="w-5 h-5" />
          </div>
        }
        title="Google Forms"
        blurb="Turn form responses into leads, reviewed before anyone is contacted"
        connected={live && sources.some((s) => s.live)}
        loading={loading}
        accent="border-violet-500/40"
        action={action}
      >
        {!loading && !config?.configured && (
          <p className="text-xs text-slate-500">
            The server has no Google OAuth client yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable this.
          </p>
        )}

        {connection && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-slate-500 shrink-0">Account</span>
              <span className="text-xs text-slate-200 truncate">{connection.accountEmail ?? 'Unknown account'}</span>
            </div>
            {!live && (
              <div className="flex items-start gap-1.5 text-xs text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Google access was revoked or expired. Reconnect to keep receiving responses.
              </div>
            )}
            {live && !pickerConfigured && (
              <p className="text-xs text-slate-500">Adding a form needs GOOGLE_PICKER_API_KEY and GOOGLE_APP_ID on the server.</p>
            )}
            {/* One account per organization. Said here because the picker will
                happily show a second account's forms, which then grant us
                nothing and fail at "Add a form" with a Google 404. */}
            {live && (
              <p className="text-2xs text-slate-500">
                Pick forms owned by this account. A form chosen while signed in as someone else cannot be read.
              </p>
            )}
          </div>
        )}

        {!loading && config?.configured && !connection && (
          <p className="text-xs text-slate-500">EstatePulse can only open the forms you choose.</p>
        )}

        {sources.length > 0 && (
          <div className="space-y-2 pt-1">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                onMap={() => setMapping(s.id)}
                onSetup={() => setSetup(s)}
                onChanged={() => void load()}
              />
            ))}
          </div>
        )}

        {connection && (
          <button
            type="button"
            onClick={disconnect}
            onBlur={() => setArmed(false)}
            disabled={busy !== null}
            className="text-2xs font-bold text-slate-500 hover:text-rose-300 transition-colors cursor-pointer disabled:opacity-40"
          >
            {busy === 'disconnect'
              ? 'Disconnecting…'
              : armed
                ? 'Click again to disconnect Google — Sheets and Forms both stop'
                : 'Disconnect Google'}
          </button>
        )}

        {error && (
          <div className="flex items-start gap-1.5 text-xs text-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </IntegrationCard>

      {mapping && (
        <FormMappingModal
          sourceId={mapping}
          onClose={() => setMapping(null)}
          onChanged={() => {
            void load();
            // Mapped, but nothing arrives until the script is installed, so
            // the setup steps follow straight on.
            const source = sources.find((s) => s.id === mapping);
            if (source && !source.live) setSetup(source);
          }}
        />
      )}
      {setup && <FormSetupModal source={setup} onClose={() => setSetup(null)} onChanged={() => void load()} />}
    </>
  );
};

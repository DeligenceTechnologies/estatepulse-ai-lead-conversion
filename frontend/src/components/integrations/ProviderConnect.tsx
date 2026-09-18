import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, AlertTriangle, Sparkles, Link2, CheckCircle2, Pencil, ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import {
  TelnyxStatus,
  TelnyxCredentials,
  TelnyxAccount,
  saveTelnyxCredentials,
  addTelnyxAccount,
  listTelnyxAccounts,
  createAssistant,
  attachAssistant,
  reconnectTelnyx,
  disconnectTelnyx,
} from '../../utils/assistantApi';
import { TelnyxAccounts } from './TelnyxAccounts';

/**
 * Bring-Your-Own-Telnyx: enter credentials, then create or attach an assistant.
 *
 * An org can keep several Telnyx accounts on file and switch between them, so
 * this panel edits *the account in use* and lists the rest below. Adding is a
 * separate act from editing on purpose — connecting a second key used to
 * overwrite the first, which is a silent way to lose an account.
 */
export const ProviderConnect: React.FC<{ status: TelnyxStatus; onChange: () => void }> = ({ status, onChange }) => {
  const [apiKey, setApiKey] = useState('');
  // A stored key is encrypted and can never be shown again, so the field reports
  // what is on file and only turns back into an input when you ask to replace it.
  const [replacingKey, setReplacingKey] = useState(false);
  const [fromNumber, setFromNumber] = useState(status.fromNumber || '');
  const [label, setLabel] = useState(status.label || '');
  // Both ids are detected from the API key, so they are an override, not a
  // question — folded away unless someone actually needs to pin a specific pair.
  const [advanced, setAdvanced] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [messagingProfileId, setMessagingProfileId] = useState('');
  const [assistantId, setAssistantId] = useState('');
  const [assistantName, setAssistantName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The shelf of saved accounts, and the separate form for putting a new one on it.
  const [accounts, setAccounts] = useState<TelnyxAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newFrom, setNewFrom] = useState('');

  const loadAccounts = useCallback(() => {
    listTelnyxAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  useEffect(loadAccounts, [loadAccounts]);

  // Every mutation moves both the status the parent holds and the shelf here.
  const refresh = () => {
    onChange();
    loadAccounts();
  };

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  // The active account changes under us when someone switches on the shelf, so
  // the edit fields follow it rather than keeping the previous account's values.
  useEffect(() => {
    setFromNumber(status.fromNumber || '');
    setLabel(status.label || '');
    setApiKey('');
    setReplacingKey(false);
  }, [status.accountId, status.fromNumber, status.label]);

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-emerald-400" />
          {status.connected
            ? status.label || 'Your Telnyx connection'
            : 'Connect your Telnyx account'}
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          EstatePulse runs the AI voice agent on <span className="text-slate-300">your own</span> Telnyx account.
          {status.connected ? ' Change the number it calls from, or swap the key.' : ' Add your credentials once'}{' — '}
          <a href="https://portal.telnyx.com" target="_blank" rel="noreferrer" className="text-emerald-400 underline">portal.telnyx.com</a>.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-rose-300 bg-rose-950/40 border border-rose-900/40 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {status.hasIntegration && !status.connected && (
        <div className="flex items-center justify-between gap-2 text-[11px] bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
          <span className="text-slate-300">You have a saved connection that's currently disconnected.</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run('reconnect', () => reconnectTelnyx())}
            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg font-bold flex items-center gap-1.5"
          >
            {busy === 'reconnect' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Reconnect
          </button>
        </div>
      )}

      {/* Step 1 — credentials */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald-600/20 text-emerald-400 text-[11px] font-bold flex items-center justify-center">1</span>
          <span className="text-xs font-semibold text-slate-200">API credentials</span>
          {status.connected && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('disconnect', () => disconnectTelnyx())}
              className="ml-auto text-[11px] text-rose-400 hover:text-rose-300 font-semibold disabled:opacity-50"
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        </div>

        <div className="space-y-3 text-xs pl-7">
          {/* Named, because an org with three of these cannot tell them apart by
              a masked key. Optional: a first account needs no disambiguating. */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Account name <span className="text-slate-500 font-normal">(so you can tell your accounts apart)</span>
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Austin office"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              API Key {!status.connected && <span className="text-rose-400 font-normal">* required</span>}
            </label>
            {status.connected && !replacingKey ? (
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="font-mono text-white truncate">{status.apiKeyMasked}</span>
                <span className="text-slate-500 shrink-0">on file</span>
                <button
                  type="button"
                  onClick={() => setReplacingKey(true)}
                  className="ml-auto text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <Pencil className="w-3 h-3" /> Replace
                </button>
              </div>
            ) : (
              <>
                <input
                  type="password"
                  value={apiKey}
                  autoFocus={replacingKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="KEY0123…"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
                {status.connected && (
                  <button
                    type="button"
                    onClick={() => { setReplacingKey(false); setApiKey(''); }}
                    className="text-[11px] text-slate-400 hover:text-slate-200 mt-1.5 cursor-pointer"
                  >
                    Cancel — keep the key already on file
                  </button>
                )}
              </>
            )}
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">From Number <span className="text-rose-400 font-normal">* required</span></label>
            <input value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} placeholder="+12025550123" className={`w-full bg-slate-950 border rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500 ${fromNumber.trim() ? 'border-slate-800' : 'border-rose-900/60'}`} />
            <p className="text-[10px] text-slate-500 mt-1">The Telnyx number calls are placed from. Required to dial leads.</p>
          </div>
        </div>

        {/* The Call Control Application and Messaging Profile are found from the
            key — and repaired if they go stale — so they are reported here as
            results rather than asked for as questions. */}
        {status.connected && (
          <div className="pl-7 space-y-2">
            <p className="text-[11px] text-slate-500">Detected from your account — nothing to enter:</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 min-w-0">
                <div className="text-[10px] text-slate-500">Voice Connection</div>
                <div className="text-[11px] font-mono text-slate-200 truncate" title={status.connectionId}>
                  {status.connectionId || 'not detected'}
                </div>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 min-w-0">
                <div className="text-[10px] text-slate-500">Messaging Profile</div>
                <div className="text-[11px] font-mono text-slate-200 truncate" title={status.messagingProfileId}>
                  {status.messagingProfileId || 'none — SMS disabled'}
                </div>
              </div>
            </div>
          </div>
        )}

        {status.connected && (
          <div className="pl-7 flex flex-wrap items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> Voice calling ready</span>
            {status.hasMessaging ? (
              <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> SMS messaging ready</span>
            ) : (
              <span className="flex items-center gap-1 text-amber-400"><AlertTriangle className="w-3.5 h-3.5" /> SMS not available — assign your number to a Telnyx Messaging Profile to enable texting</span>
            )}
          </div>
        )}

        <div className="pl-7">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-[11px] text-slate-400 hover:text-slate-200 font-semibold flex items-center gap-1 cursor-pointer"
          >
            {advanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Advanced — override the detected IDs
          </button>

          {advanced && (
            <div className="mt-2 space-y-3">
              <p className="text-[11px] text-slate-500 leading-relaxed">
                We pick the Call Control Application and Messaging Profile off your API key and fix
                them if they drift. Set these only when your account has more than one and calls must
                go through a specific pair. Left blank, detection stays on.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1 text-xs">Voice Connection ID</label>
                  <input value={connectionId} onChange={(e) => setConnectionId(e.target.value)} placeholder={status.connectionId || 'Leave blank to auto-detect'} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-slate-300 font-semibold mb-1 text-xs">Messaging Profile ID</label>
                  <input value={messagingProfileId} onChange={(e) => setMessagingProfileId(e.target.value)} placeholder={status.messagingProfileId || 'Leave blank to auto-detect'} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-emerald-500" />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="pl-7">
          <button
            type="button"
            disabled={busy !== null || (!apiKey && !status.connected) || !fromNumber.trim()}
            onClick={() =>
              run('save', () => {
                const payload: TelnyxCredentials = { fromNumber, label };
                if (apiKey) payload.apiKey = apiKey;
                // Overrides only travel when Advanced is open and filled in. Echoing
                // the stored ids back would pin the connection to them and stop the
                // server re-detecting — which is how a stale id survives a re-save.
                if (advanced && connectionId.trim()) payload.connectionId = connectionId.trim();
                if (advanced && messagingProfileId.trim()) payload.messagingProfileId = messagingProfileId.trim();
                return saveTelnyxCredentials(payload).then((r) => {
                  setApiKey('');
                  setReplacingKey(false);
                  return r;
                });
              })
            }
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5"
          >
            {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            {status.connected ? 'Save changes' : 'Connect'}
          </button>
          {!fromNumber.trim() && <p className="text-[10px] text-rose-400 mt-1.5">A From Number is required before you can save.</p>}
        </div>
      </div>

      {/* The other accounts on file, and the way to put another one there. */}
      {status.connected && (
        <div className="space-y-3 border-t border-slate-800 pt-4">
          <TelnyxAccounts accounts={accounts} onChange={refresh} />

          {adding ? (
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-white">Add another Telnyx account</p>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="p-1 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                It is saved alongside the others and becomes the active one — calls and SMS switch
                to it straight away. The account you are on now is kept, not replaced.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Name (e.g. Dallas office)"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-emerald-500"
                />
                <input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="API key (KEY0123…)"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
                <input
                  value={newFrom}
                  onChange={(e) => setNewFrom(e.target.value)}
                  placeholder="From number (+1…)"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              <button
                type="button"
                disabled={busy !== null || !newApiKey.trim() || !newFrom.trim()}
                onClick={() =>
                  run('add', () =>
                    addTelnyxAccount({
                      label: newLabel.trim(),
                      apiKey: newApiKey.trim(),
                      fromNumber: newFrom.trim(),
                    }).then((r) => {
                      setNewLabel('');
                      setNewApiKey('');
                      setNewFrom('');
                      setAdding(false);
                      return r;
                    }),
                  )
                }
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5"
              >
                {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Add and switch to it
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-[11px] text-slate-400 hover:text-slate-200 font-semibold flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add another Telnyx account
            </button>
          )}
        </div>
      )}

      {/* Step 2 — assistant */}
      <div className={`space-y-3 ${status.connected ? '' : 'opacity-40 pointer-events-none'}`}>
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald-600/20 text-emerald-400 text-[11px] font-bold flex items-center justify-center">2</span>
          <span className="text-xs font-semibold text-slate-200">AI voice assistant</span>
        </div>

        <div className="pl-7 grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Option A: auto-create */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <p className="text-xs font-semibold text-white flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-amber-400" /> Create with default settings</p>
            <p className="text-[11px] text-slate-400 mt-1 mb-2">Name it, and we'll create a ready-to-use real-estate qualifier assistant in your account.</p>
            <input
              value={assistantName}
              onChange={(e) => setAssistantName(e.target.value)}
              placeholder="Assistant name (e.g. Austin Home Advisors)"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white text-xs mb-2 focus:outline-none focus:border-emerald-500"
            />
            <button type="button" disabled={busy !== null || !assistantName.trim()} onClick={() => run('create', () => createAssistant(assistantName))} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5">
              {busy === 'create' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Create assistant
            </button>
          </div>

          {/* Option B: attach existing */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <p className="text-xs font-semibold text-white flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5 text-cyan-400" /> Use an existing assistant</p>
            <p className="text-[11px] text-slate-400 mt-1 mb-2">Already built one in Telnyx? Paste its ID.</p>
            <div className="flex items-center gap-2">
              <input value={assistantId} onChange={(e) => setAssistantId(e.target.value)} placeholder="assistant-…" className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-emerald-500" />
              <button type="button" disabled={busy !== null || !assistantId} onClick={() => run('attach', () => attachAssistant(assistantId.trim()))} className="px-3 py-1.5 border border-slate-700 hover:border-slate-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold">
                {busy === 'attach' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Attach'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

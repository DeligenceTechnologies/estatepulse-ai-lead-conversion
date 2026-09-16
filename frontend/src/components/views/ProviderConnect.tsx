import React, { useState } from 'react';
import { KeyRound, Loader2, AlertTriangle, Sparkles, Link2, CheckCircle2 } from 'lucide-react';
import { TelnyxStatus, saveTelnyxCredentials, createAssistant, attachAssistant, reconnectTelnyx, disconnectTelnyx } from '../../utils/assistantApi';

// Bring-Your-Own-Telnyx onboarding: enter credentials, then create or attach an assistant.
export const ProviderConnect: React.FC<{ status: TelnyxStatus; onChange: () => void }> = ({ status, onChange }) => {
  const [apiKey, setApiKey] = useState('');
  const [connectionId, setConnectionId] = useState(status.connectionId || '');
  const [messagingProfileId, setMessagingProfileId] = useState(status.messagingProfileId || '');
  const [fromNumber, setFromNumber] = useState(status.fromNumber || '');
  const [assistantId, setAssistantId] = useState('');
  const [assistantName, setAssistantName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-emerald-400" />
          Connect your Telnyx account
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          EstatePulse runs the AI voice agent on <span className="text-slate-300">your own</span> Telnyx account.
          Add your credentials once — get them from{' '}
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
            <span className="text-[11px] flex items-center gap-2">
              <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> connected ({status.apiKeyMasked})</span>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('disconnect', () => disconnectTelnyx())}
                className="text-rose-400 hover:text-rose-300 font-semibold disabled:opacity-50"
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pl-7">
          <div className="md:col-span-2">
            <label className="block text-slate-300 font-semibold mb-1">API Key {status.connected && <span className="text-slate-500 font-normal">(leave blank to keep current)</span>}</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="KEY0123…" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-slate-300 font-semibold mb-1">Voice Connection ID <span className="text-slate-500 font-normal">(optional)</span></label>
            <input value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-slate-300 font-semibold mb-1">From Number <span className="text-slate-500 font-normal">(optional)</span></label>
            <input value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} placeholder="+1…" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-slate-300 font-semibold mb-1">Messaging Profile ID <span className="text-slate-500 font-normal">(optional)</span></label>
            <input value={messagingProfileId} onChange={(e) => setMessagingProfileId(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500" />
          </div>
        </div>

        <div className="pl-7">
          <button
            type="button"
            disabled={busy !== null || (!apiKey && !status.connected)}
            onClick={() => run('save', () => saveTelnyxCredentials({ apiKey: apiKey || undefined as any, connectionId, messagingProfileId, fromNumber }))}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5"
          >
            {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            Save credentials
          </button>
        </div>
      </div>

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

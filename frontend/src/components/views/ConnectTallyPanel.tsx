import React, { useEffect, useState } from 'react';
import { Link2, Plus, CheckCircle2, AlertTriangle, FileText, Loader2, X } from 'lucide-react';
import {
  tallyConnections,
  tallyConnect,
  tallyForms,
  tallyConnectForm,
  tallyLeadSources,
  type TallyConnection,
  type TallyForm,
  type TallyLeadSource,
} from '../../utils/assistantApi';

/**
 * Tally lead-source connection, presented as an integration card (matching the
 * others). Clicking the card opens a small centered modal that runs the connect
 * flow through our JWT-authed bridge (/api/tally/*): paste API key -> pick a
 * form -> install (creates the source + webhook on Tally). Submissions then flow
 * through the ingestion worker into the calling engine.
 */
export const ConnectTallyPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<TallyConnection[]>([]);
  const [sources, setSources] = useState<TallyLeadSource[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [forms, setForms] = useState<TallyForm[]>([]);
  const [formName, setFormName] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadingForms, setLoadingForms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => {
    void tallyConnections().then(setConnections).catch(() => setConnections([]));
    void tallyLeadSources().then(setSources).catch(() => setSources([]));
  };
  useEffect(() => { refresh(); }, []);

  const connected = connections.length > 0 || sources.length > 0;
  const connectedFormIds = new Set(sources.map((s) => s.externalFormId).filter(Boolean));

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const conn = await tallyConnect(key, label.trim() || undefined);
      setApiKey(''); setLabel('');
      setNotice('Tally account connected.');
      refresh();
      if (conn?.id) void loadForms(conn.id);
    } catch (e) {
      setError((e as Error).message || 'Could not connect. Check the API key.');
    } finally {
      setBusy(false);
    }
  };

  const loadForms = async (id: string) => {
    setSelected(id); setForms([]); setLoadingForms(true); setError(null);
    try {
      const res = await tallyForms(id);
      setForms(res.items ?? []);
    } catch (e) {
      setError((e as Error).message || 'Could not load forms');
    } finally {
      setLoadingForms(false);
    }
  };

  const install = async (form: TallyForm) => {
    if (!selected) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await tallyConnectForm(selected, form.externalFormId, formName[form.externalFormId]?.trim() || form.name);
      setNotice(`Connected "${form.name}". New submissions will create leads and enter your calling strategy.`);
      refresh();
    } catch (e) {
      setError((e as Error).message || 'Could not install the webhook');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Card — a direct cell of the integration grid it's rendered into */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left bg-slate-900/90 border border-slate-800 hover:border-emerald-700/60 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col justify-between transition-colors cursor-pointer"
      >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300">Lead Source</span>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 ${
                connected ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-slate-800 text-slate-400'
              }`}>
                {connected && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                {connected ? 'connected' : 'not connected'}
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                <Link2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Tally</h3>
                <p className="text-[11px] text-slate-400">Form submissions → leads → calling strategy</p>
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-1.5 text-xs">
              <div className="flex items-center justify-between text-slate-400">
                <span>Accounts connected:</span>
                <span className={connections.length ? 'text-emerald-400 font-semibold' : 'text-slate-500'}>{connections.length}</span>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Live forms:</span>
                <span className={sources.length ? 'text-emerald-400 font-semibold' : 'text-slate-500'}>{sources.length}</span>
              </div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 text-emerald-400 text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> {connected ? 'Manage / add form' : 'Connect Tally'}
          </span>
        </button>

      {/* Centered modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-md bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100 flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                  <Link2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Connect Tally</h3>
                  <p className="text-[11px] text-slate-400">Paste your API key, pick a form — we install the webhook</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
              <p className="text-[11px] text-slate-400">
                Find it in <span className="font-mono text-slate-300">Tally → Settings → API keys</span>. Submissions become leads and immediately enter your calling strategy — no manual URL copying.
              </p>

              {/* Connect account */}
              <div className="space-y-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Tally API key"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none font-mono"
                />
                <div className="flex gap-2">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label (optional)"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    onClick={() => void connect()}
                    disabled={busy || !apiKey.trim()}
                    className="flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors cursor-pointer"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Connect
                  </button>
                </div>
              </div>

              {error && <div className="flex items-center gap-1.5 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}</div>}
              {notice && <div className="flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5 shrink-0" />{notice}</div>}

              {/* Connected accounts */}
              {connections.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Connected accounts</div>
                  {connections.map((c) => (
                    <div key={c.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">{c.label || c.displayName || c.accountEmail || 'Tally account'}</div>
                        <div className="text-[11px] text-slate-500 truncate">{c.accountEmail || c.verificationState || c.status || 'connected'}</div>
                      </div>
                      <button
                        onClick={() => void loadForms(c.id)}
                        disabled={busy}
                        className="text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                      >
                        Pick a form →
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Forms */}
              {selected && (
                <div className="space-y-2 border-t border-slate-800 pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                    <FileText className="w-3 h-3" /> Forms {loadingForms && <Loader2 className="w-3 h-3 animate-spin" />}
                  </div>
                  {!loadingForms && forms.length === 0 && <div className="text-xs text-slate-500 italic">No forms found on this account.</div>}
                  {forms.map((f) => {
                    const isConnected = connectedFormIds.has(f.externalFormId);
                    return (
                    <div key={f.externalFormId} className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-white truncate">{f.name}</div>
                        <div className="text-[11px] text-slate-500">{f.submissionCount ?? 0} submissions{f.isClosed ? ' · closed' : ''}</div>
                      </div>
                      {isConnected ? (
                        <span className="shrink-0 flex items-center gap-1 text-[11px] font-semibold text-emerald-400 px-2.5 py-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                        </span>
                      ) : (
                        <button
                          onClick={() => void install(f)}
                          disabled={busy}
                          className="shrink-0 flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
                        >
                          <Plus className="w-3 h-3" /> Connect
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* Connected sources */}
              {sources.length > 0 && (
                <div className="space-y-2 border-t border-slate-800 pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Live forms</div>
                  {sources.map((s) => (
                    <div key={s.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">{s.name}</div>
                        {s.webhookUrl && <div className="text-[11px] text-slate-500 font-mono truncate">{s.webhookUrl}</div>}
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${s.isActive === false ? 'bg-slate-800 text-slate-400' : 'bg-emerald-900/60 text-emerald-300'}`}>
                        {s.remoteState || s.ingestStatus || (s.isActive === false ? 'Disabled' : 'Active')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

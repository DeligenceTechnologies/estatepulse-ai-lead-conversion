import React, { useEffect, useState } from 'react';
import { Webhook, Plus, Copy, Check, Power, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  listIngestSources,
  createIngestSource,
  setIngestSourceActive,
  type IngestSource,
  type NewIngestSource,
} from '../../utils/assistantApi';

/**
 * Real lead-ingestion source manager. A tenant mints a webhook token here and
 * pastes the resulting URL into Tally / a website form / Zapier. Inbound posts
 * create a lead (status 'new') and immediately enter the strategy engine.
 * The plaintext token is returned only once (only its hash is stored), so the
 * freshly minted URL is surfaced in a copy-me-now banner.
 */
export const IngestSourcesCard: React.FC = () => {
  const [sources, setSources] = useState<IngestSource[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<NewIngestSource | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = () => listIngestSources().then(setSources).catch(() => setSources([]));
  useEffect(() => { void refresh(); }, []);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch { /* clipboard blocked — user can select manually */ }
  };

  const create = async () => {
    const name = label.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createIngestSource(name);
      setMinted(res);
      setLabel('');
      await refresh();
    } catch (e) {
      setError((e as Error).message || 'Could not create source');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: IngestSource) => {
    setBusy(true);
    try {
      await setIngestSourceActive(s.id, !s.active);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Webhook className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-white">Lead Ingestion Sources</h3>
        </div>
        <button
          onClick={() => void refresh()}
          className="text-slate-400 hover:text-white transition-colors cursor-pointer"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="text-xs text-slate-300">
        Create a webhook token, then paste its URL into Tally, a website form, Zillow, Meta Lead Ads, or Zapier/Make.
        Each inbound lead is created as <span className="font-mono text-emerald-400">new</span> and enters your calling strategy automatically.
      </p>

      {/* Create */}
      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder="Source name (e.g. Website Contact Form)"
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
        />
        <button
          onClick={() => void create()}
          disabled={busy || !label.trim()}
          className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold px-3 py-2 rounded-xl transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> Create
        </button>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* One-time token banner */}
      {minted && (
        <div className="bg-emerald-950/40 border border-emerald-800 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-emerald-300 text-xs font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" />
            Copy this now — the token is shown only once.
          </div>
          {([
            ['Webhook URL (generic JSON)', minted.webhookUrl, 'url'],
            ['Tally webhook URL', minted.tallyUrl, 'tally'],
            ['Token', minted.token, 'token'],
          ] as const).map(([title, value, key]) => (
            <div key={key} className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{title}</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px] text-slate-200 font-mono break-all">
                  {value || '(set PUBLIC_API_URL to get a full URL)'}
                </code>
                <button
                  onClick={() => void copy(key, value)}
                  className="text-slate-400 hover:text-white transition-colors cursor-pointer shrink-0"
                  title="Copy"
                >
                  {copied === key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          ))}
          <button onClick={() => setMinted(null)} className="text-[11px] text-slate-400 hover:text-white cursor-pointer">
            Done
          </button>
        </div>
      )}

      {/* List */}
      <div className="space-y-2 pt-1">
        {sources.length === 0 && (
          <div className="text-xs text-slate-500 italic">No ingestion sources yet. Create one above.</div>
        )}
        {sources.map((s) => (
          <div key={s.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white truncate">{s.label}</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {s.prefix ? `${s.prefix}…` : 'no token'} · {new Date(s.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${s.active ? 'bg-emerald-900/60 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
                {s.active ? 'Active' : 'Disabled'}
              </span>
              <button
                onClick={() => void toggle(s)}
                disabled={busy}
                className={`transition-colors cursor-pointer disabled:opacity-40 ${s.active ? 'text-emerald-400 hover:text-emerald-300' : 'text-slate-500 hover:text-slate-300'}`}
                title={s.active ? 'Disable' : 'Enable'}
              >
                <Power className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

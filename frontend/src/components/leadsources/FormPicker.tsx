import React, { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, FileQuestion, Loader2, RefreshCw, Search } from 'lucide-react';
import type { ProviderForm } from '../../api/client';

/**
 * Pick the form to connect.
 *
 * Forms we already feed from are shown but not selectable: catching a duplicate
 * here is a courtesy, since the backend's unique index is what actually stops
 * it (a check-then-insert races a double click).
 */
export const FormPicker: React.FC<{
  forms: ProviderForm[] | null;
  loading: boolean;
  selected: string | null;
  onSelect: (externalFormId: string) => void;
  onRefresh: () => void;
  onOpenSource: (leadSourceId: string) => void;
}> = ({ forms, loading, selected, onSelect, onRefresh, onOpenSource }) => {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    if (!forms) return [];
    const q = query.trim().toLowerCase();
    return q ? forms.filter((f) => f.name.toLowerCase().includes(q)) : forms;
  }, [forms, query]);

  if (loading && !forms) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading your forms…
      </div>
    );
  }

  // Not an error: a brand new account legitimately has no forms yet.
  if (forms && forms.length === 0) {
    return (
      <div className="text-center space-y-2 py-6">
        <FileQuestion className="w-6 h-6 text-slate-600 mx-auto" />
        <div className="text-xs text-slate-400">No forms in this account yet.</div>
        <div className="text-[11px] text-slate-500 max-w-sm mx-auto leading-relaxed">
          Build and publish a form with your provider, then refresh.
        </div>
        <button
          onClick={onRefresh}
          className="mx-auto px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter forms…"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <button
          onClick={onRefresh}
          title="Refresh"
          className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* The picker cannot detect this for sources created the old way:
          external_form_id is null on every one of them. */}
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-2 text-[11px] text-amber-200 leading-relaxed flex gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        Already pasted our webhook URL into one of these by hand? Remove it there first — otherwise
        every submission arrives twice.
      </div>

      <div className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar">
        {visible.map((f) => {
          const taken = Boolean(f.connectedLeadSourceId);
          const isSelected = selected === f.externalFormId;
          return (
            <div
              key={f.externalFormId}
              onClick={() => !taken && onSelect(f.externalFormId)}
              className={`bg-slate-950 border rounded-xl p-3 flex items-center justify-between gap-3 transition-colors ${
                taken
                  ? 'border-slate-800/80 opacity-60'
                  : isSelected
                    ? 'border-emerald-500/50 cursor-pointer'
                    : 'border-slate-800 hover:border-slate-700 cursor-pointer'
              }`}
            >
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white truncate">{f.name}</div>
                <div className="text-[10px] text-slate-500 flex items-center gap-2 mt-0.5">
                  {f.status && <span className="font-mono">{f.status.toLowerCase()}</span>}
                  <span>{f.submissionCount ?? 0} submissions</span>
                  {f.isClosed && <span className="text-amber-400">closed</span>}
                </div>
              </div>

              {taken ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSource(f.connectedLeadSourceId!);
                  }}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold shrink-0 transition-colors cursor-pointer flex items-center gap-1"
                >
                  connected
                  <ExternalLink className="w-3 h-3" />
                </button>
              ) : (
                <div
                  className={`w-4 h-4 rounded-full border shrink-0 ${
                    isSelected ? 'bg-emerald-500 border-emerald-400' : 'border-slate-600'
                  }`}
                />
              )}
            </div>
          );
        })}

        {visible.length === 0 && (
          <div className="text-[11px] text-slate-500 text-center py-4">No form matches "{query}".</div>
        )}
      </div>
    </div>
  );
};

import React from 'react';
import { Check, Loader2 } from 'lucide-react';

/**
 * The shell every card on Integrations & Webhooks is built from.
 *
 * It lived inside ConnectionCards while the page only had lead sources on it.
 * The Telnyx connection moved here from AI Agent settings and needs the same
 * object — header, connected badge, body, one action at the bottom — so the
 * shell is its own file rather than a copy that drifts.
 */
export const IntegrationCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  blurb: string;
  connected: boolean;
  /**
   * Still fetching. The card keeps its name and icon so the page says *what* is
   * loading rather than showing interchangeable spinners, and the badge reads
   * "Checking" — rendering "Not connected" before the answer is in would be a
   * wrong statement that quietly corrects itself a few seconds later.
   */
  loading?: boolean;
  /** Border colour once connected, so a live card is identifiable at a glance. */
  accent: string;
  action: { label: string; icon: React.ReactNode; onClick: () => void; className: string };
  children: React.ReactNode;
}> = ({ icon, title, blurb, connected, loading, accent, action, children }) => (
  <div
    className={`bg-slate-900/90 border rounded-2xl p-5 shadow-xl flex flex-col gap-4 ${
      connected && !loading ? accent : 'border-slate-800'
    }`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon}
        <div className="min-w-0">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <p className="text-[11px] text-slate-400 truncate">{blurb}</p>
        </div>
      </div>
      <span
        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border flex items-center gap-1 shrink-0 ${
          connected && !loading
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
            : 'bg-slate-800 text-slate-400 border-slate-700'
        }`}
      >
        {loading ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" /> Checking
          </>
        ) : (
          <>
            {connected && <Check className="w-3 h-3" />}
            {connected ? 'Connected' : 'Not connected'}
          </>
        )}
      </span>
    </div>

    <div className="flex-1 space-y-2">{children}</div>

    <button
      type="button"
      onClick={action.onClick}
      disabled={loading}
      className={`w-full px-4 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${action.className}`}
    >
      {action.icon}
      {action.label}
    </button>
  </div>
);

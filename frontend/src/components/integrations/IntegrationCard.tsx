import React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button, type ButtonVariant } from '../common/Button';

/**
 * An integration card's shell: header, connected badge, body, one action at
 * the bottom. Used by the Telnyx card.
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
  /** The card's one button. Primary for connect / add, secondary for everything after that. */
  action: {
    label: string;
    icon: React.ReactElement<{ className?: string }>;
    onClick: () => void;
    variant?: ButtonVariant;
    disabled?: boolean;
  };
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
          <p className="text-xs text-slate-400 line-clamp-2">{blurb}</p>
        </div>
      </div>
      <span
        className={`text-2xs font-semibold px-2.5 py-1 rounded-full border flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
          connected && !loading
            ? 'bg-green-500/10 text-green-300 border-green-500/25'
            : 'bg-slate-500/10 text-slate-400 border-slate-500/25'
        }`}
      >
        {loading ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" /> Checking
          </>
        ) : (
          <>
            {connected ? <Check className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />}
            {connected ? 'Connected' : 'Not connected'}
          </>
        )}
      </span>
    </div>

    {/* Scrolls when the card is given a height (Lead Integrations does) and its content outgrows it; otherwise it just grows. */}
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 pr-1 -mr-1">{children}</div>

    <Button
      variant={action.variant ?? 'primary'}
      fullWidth
      onClick={action.onClick}
      disabled={loading || action.disabled}
      icon={action.icon}
    >
      {action.label}
    </Button>
  </div>
);

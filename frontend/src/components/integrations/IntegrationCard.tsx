import React, { createContext, useContext } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button, type ButtonVariant } from '../common/Button';

/**
 * True inside a Connections drawer, whose own header already names the
 * provider and its status: the card then drops its chrome and header and
 * shows only its body and action.
 */
export const EmbeddedCardContext = createContext(false);

/**
 * The shell every card on Lead Integrations is built from.
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
  /** The card's one button. Primary for connect / add, secondary for everything after that. */
  action: {
    label: string;
    icon: React.ReactElement<{ className?: string }>;
    onClick: () => void;
    variant?: ButtonVariant;
    disabled?: boolean;
  };
  children: React.ReactNode;
}> = (props) => (useContext(EmbeddedCardContext) ? <EmbeddedCard {...props} /> : <FullCard {...props} />);

type CardProps = React.ComponentProps<typeof IntegrationCard>;

/** Inside a drawer: a titled section with the card's body and action. */
const EmbeddedCard: React.FC<CardProps> = ({ title, blurb, loading, action, children }) => (
  <section className="space-y-3">
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</h4>
      <p className="text-xs text-slate-500 mt-0.5">{blurb}</p>
    </div>
    <div className="space-y-2">{children}</div>
    <Button variant={action.variant ?? 'primary'} onClick={action.onClick} disabled={loading || action.disabled} icon={action.icon}>
      {action.label}
    </Button>
  </section>
);

const FullCard: React.FC<CardProps> = ({ icon, title, blurb, connected, loading, accent, action, children }) => (
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

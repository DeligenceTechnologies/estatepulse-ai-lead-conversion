import React, { useEffect, useState } from 'react';
import { ChevronRight, Radio, Webhook } from 'lucide-react';
import { ConnectFormPanel } from './ConnectFormPanel';
import { ManualWebhookPanel, PanelClose } from './ManualWebhookPanel';

/**
 * The one place a lead source gets connected.
 *
 * It lives on Integrations & Webhooks, not on Lead Sources: connecting is a
 * setup act you do once, while Lead Sources is a monitoring screen you come back
 * to. Mixing them meant the screen you check daily was dominated by buttons you
 * press twice a year.
 *
 * Two routes in, and the difference between them is what we are trusted with,
 * not how hard they are:
 *  - Tally: we hold an API key, install the webhook, and can repair it later.
 *  - Webhook: we hold nothing, hand over a URL and secret, and cannot.
 */

export type ConnectKind = 'TALLY' | 'WEBHOOK';

type Step = { k: 'choose' } | { k: 'tally' } | { k: 'webhook' };

const Option: React.FC<{
  icon: React.ReactNode;
  title: string;
  blurb: string;
  detail: string;
  onClick: () => void;
  accent: string;
}> = ({ icon, title, blurb, detail, onClick, accent }) => (
  <button
    onClick={onClick}
    className={`w-full text-left bg-slate-950 border rounded-xl p-4 flex items-start gap-3 transition-colors cursor-pointer ${accent}`}
  >
    <div className="mt-0.5 shrink-0">{icon}</div>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-bold text-white">{title}</div>
      <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{blurb}</div>
      <div className="text-xs text-slate-500 mt-1.5 leading-relaxed">{detail}</div>
    </div>
    <ChevronRight className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" />
  </button>
);

export const ConnectModal: React.FC<{
  /** Skips the chooser when the user already picked on the card they clicked. */
  initial?: ConnectKind;
  onClose: () => void;
  /** A source now exists — refresh whatever list the caller is showing. */
  onConnected: (leadSourceId: string) => void;
  /** Jump to this source on the Lead Sources screen. */
  onOpenSource: (leadSourceId: string) => void;
}> = ({ initial, onClose, onConnected, onOpenSource }) => {
  const [step, setStep] = useState<Step>(
    initial === 'TALLY' ? { k: 'tally' } : initial === 'WEBHOOK' ? { k: 'webhook' } : { k: 'choose' },
  );

  // Escape closes, and the page behind must not scroll under the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg my-8"
        // The overlay closes on click; the card must not inherit that.
        onClick={(e) => e.stopPropagation()}
      >
        {step.k === 'choose' && (
          <div className="bg-slate-900/95 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-white">Connect a lead source</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Where should new leads come from?
                </p>
              </div>
              <PanelClose onClose={onClose} />
            </div>

            <Option
              icon={<Radio className="w-4 h-4 text-emerald-400" />}
              title="Tally"
              blurb="Pick a form and we install the webhook on it for you."
              detail="Needs an API key. In exchange we can read the form's questions before the first submission arrives, and repair or remove the webhook later."
              accent="border-emerald-500/40 hover:border-emerald-500/70"
              onClick={() => setStep({ k: 'tally' })}
            />

            <Option
              icon={<Webhook className="w-4 h-4 text-amber-400" />}
              title="Webhook"
              blurb="We give you a URL and a signing secret to paste in yourself."
              detail="No API key, so it works with any form tool — and we hold no credential, so repairing it later is on you."
              accent="border-slate-800 hover:border-slate-700"
              onClick={() => setStep({ k: 'webhook' })}
            />
          </div>
        )}

        {step.k === 'tally' && (
          <ConnectFormPanel
            onClose={onClose}
            onConnected={onConnected}
            onOpenSource={onOpenSource}
            onSetUpManually={() => setStep({ k: 'webhook' })}
          />
        )}

        {step.k === 'webhook' && (
          <div className="bg-slate-900/95 border border-amber-500/40 rounded-2xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Webhook className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-white">Webhook</h3>
              </div>
              <PanelClose onClose={onClose} />
            </div>
            <ManualWebhookPanel onClose={onClose} onCreated={onConnected} />
          </div>
        )}
      </div>
    </div>
  );
};

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PhoneCall, Plus, Settings2 } from 'lucide-react';
import { getTelnyxStatus, type TelnyxStatus } from '../../utils/assistantApi';
import { PanelClose } from '../leadsources/ManualWebhookPanel';
import { IntegrationCard } from './IntegrationCard';
import { ProviderConnect } from './ProviderConnect';

/**
 * Telnyx — the account the AI agent places calls and sends SMS from.
 *
 * Connecting it used to happen on AI Agent & Qualification Rules, which meant
 * the screen for writing the prompt opened on a credentials form until someone
 * filled it in. Connecting is setup, so it belongs on the page that owns setup,
 * in the same card as every other connection. AI settings now reads the status
 * and points here when there is nothing connected yet.
 */

/** One labelled fact about the live connection. */
const Fact: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-[11px] text-slate-500 shrink-0">{label}</span>
    <span className={`text-[11px] text-slate-200 truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

/** The credentials + assistant flow, in the same overlay the other cards use. */
const TelnyxConnectModal: React.FC<{
  status: TelnyxStatus;
  onClose: () => void;
  onChange: () => void;
}> = ({ status, onClose, onChange }) => {
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
      <div className="w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end mb-2">
          <PanelClose onClose={onClose} />
        </div>
        <ProviderConnect status={status} onChange={onChange} />
      </div>
    </div>
  );
};

export const TelnyxCard: React.FC = () => {
  const [status, setStatus] = useState<TelnyxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getTelnyxStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus({ connected: false, hasAssistant: false } as TelnyxStatus);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loading = status === null;
  const connected = !!status?.connected;
  // A saved-but-disconnected integration is its own state: the card must not
  // read as "never set up" when there are credentials waiting to be reconnected.
  const saved = !connected && !!status?.hasIntegration;

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-violet-600/20 text-violet-300 flex items-center justify-center border border-violet-500/30 shrink-0">
            <PhoneCall className="w-5 h-5" />
          </div>
        }
        title="Telnyx"
        blurb={
          connected && status?.label
            ? status.label
            : 'The account your AI agent calls and texts from'
        }
        connected={connected}
        loading={loading}
        accent="border-violet-500/40"
        action={{
          label: loading
            ? 'Checking connection…'
            : connected
              ? 'Manage connection'
              : saved
                ? 'Reconnect Telnyx'
                : 'Connect Telnyx',
          icon: connected ? <Settings2 className="w-4 h-4" /> : <Plus className="w-4 h-4" />,
          onClick: () => setOpen(true),
          className: 'bg-violet-600 hover:bg-violet-500 text-white shadow-md shadow-violet-950',
        }}
      >
        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
            <div className="text-[11px] text-rose-200 leading-relaxed">{error}</div>
          </div>
        )}

        {loading ? (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-[11px] text-slate-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Checking your Telnyx connection…
          </div>
        ) : connected ? (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1.5">
            {/* The key is never printed, masked or otherwise. It proves
                nothing a reader can act on — "connected" already says the
                credential works — and a secret on screen is a secret in every
                screenshot and screen share of this page. */}
            <Fact label="From number" value={status!.fromNumber || 'none assigned'} mono />
            {status!.accountCount > 1 && (
              <Fact
                label="Accounts"
                value={`${status!.accountCount} saved · 1 active`}
              />
            )}
            <div className="pt-1.5 mt-1.5 border-t border-slate-800/80 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Voice calling ready
              </div>
              {status!.hasMessaging ? (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> SMS messaging ready
                </div>
              ) : (
                <div className="flex items-start gap-1.5 text-[11px] text-amber-400 leading-relaxed">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  SMS unavailable — assign your number to a Telnyx Messaging Profile to enable texting
                </div>
              )}
              {status!.hasAssistant ? (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> AI assistant attached
                </div>
              ) : (
                <div className="flex items-start gap-1.5 text-[11px] text-amber-400 leading-relaxed">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  No AI assistant yet — create or attach one before the agent can take a call
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-[11px] text-slate-400 leading-relaxed">
            {saved ? (
              <>
                Credentials are saved but the connection is currently disconnected. Reconnect to let
                the AI agent place calls again.
              </>
            ) : (
              <>
                The AI voice agent runs on <span className="text-slate-200">your own</span> Telnyx
                account. Add your API key and the number to call from, then create or attach the
                assistant — after that, prompt and tone are edited on AI Agent settings.
              </>
            )}
          </div>
        )}
      </IntegrationCard>

      {open && (
        <TelnyxConnectModal
          status={status!}
          onClose={() => setOpen(false)}
          onChange={() => {
            void load();
          }}
        />
      )}
    </>
  );
};

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, Loader2, PhoneCall, Plus, Settings2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { useApp } from '../../context/AppContext';
import { getTelnyxStatus } from '../../utils/assistantApi';
import { Overlay } from '../common/Overlay';
import { IntegrationCard } from './IntegrationCard';
import { Ok, RetellConnect } from './RetellConnect';
import { Fact, TelnyxCard } from './TelnyxCard';
import {
  PROVIDER_LABEL,
  getCallingProvider,
  getSwitchPreview,
  refreshCallingProvider,
  switchCallingProvider,
  type CallingProviderName,
  type SmsCapability,
  type SwitchPreview,
} from '../../utils/callingProviderApi';
import { getRetellSms, getRetellStatus, retellMessage, type RetellStatus } from '../../utils/retellApi';

/**
 * Settings → Calling, shown only when Retell is enabled on the server: which
 * provider the organization calls through (Telnyx or Retell), the switch, and
 * each provider's own setup. Texts go through the same provider as calls:
 * Telnyx's messaging, or Retell's SMS agent once it is set up on an eligible
 * number. Never one provider's calls with the other's texts.
 */

const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4';
const primary =
  'px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer flex items-center gap-1.5 shrink-0';
const secondary =
  'px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-40 text-xs font-semibold cursor-pointer flex items-center gap-1.5 shrink-0';

const PROVIDER_CARDS: Record<CallingProviderName, { tagline: string; tone: string; selected: string }> = {
  telnyx: {
    tagline: 'AI calls and SMS on your own Telnyx account.',
    tone: 'bg-violet-600/20 text-violet-300 border-violet-500/30',
    selected: 'border-violet-500/60 bg-violet-500/[0.06]',
  },
  retell: {
    tagline: 'AI calls on your own Retell workspace; SMS too, from a Retell (Twilio) US number with the SMS add-on approved.',
    tone: 'bg-sky-600/20 text-sky-300 border-sky-500/30',
    selected: 'border-sky-500/60 bg-sky-500/[0.06]',
  },
};

/** Making `to` the calling provider, with what it would block or change shown before it happens. */
const SwitchBox: React.FC<{ to: CallingProviderName; onSwitched: () => void }> = ({ to, onSwitched }) => {
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [to]);

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await getSwitchPreview(to));
    } catch (e) {
      setError(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await switchCallingProvider(to);
      toast.success(`Calls now go through ${PROVIDER_LABEL[to]}.`);
      setPreview(null);
      onSwitched();
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      {preview ? (
        <>
          {preview.blockers.length > 0 && (
            <ul className="space-y-1 text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2 list-none">
              {preview.blockers.map((b) => (
                <li key={b} className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {b}
                </li>
              ))}
            </ul>
          )}
          <ul className="space-y-1 text-xs text-slate-300 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 list-disc pl-6">
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" className={secondary} onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className={primary} onClick={() => void confirm()} disabled={busy || preview.blockers.length > 0}>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Switch to {PROVIDER_LABEL[to]}
            </button>
          </div>
        </>
      ) : (
        <div className="flex justify-end">
          <button type="button" className={primary} onClick={() => void review()} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowLeftRight className="w-3.5 h-3.5" />} Use {PROVIDER_LABEL[to]} for calls…
          </button>
        </div>
      )}
    </div>
  );
};

/** The keys, number, agent and SMS flow, in the same overlay the Telnyx card opens. */
const RetellConnectModal: React.FC<{ status: RetellStatus; onClose: () => void; onChange: () => void }> = ({ status, onClose, onChange }) => {
  const { setActiveView } = useApp();
  /**
   * Once an agent is in place the setup is done here; what comes next (prompt,
   * voice, number, SMS) is on AI Agent settings, which shows the Retell agent
   * only once Retell is the calling provider. So setting Retell up makes it
   * the provider at once, as connecting a Telnyx account does, and the owner
   * lands on AI Agent settings. Only a real blocker (a call still live, no
   * number chosen) keeps the setup open, with the reason.
   */
  const openAgentSettings = async () => {
    const calling = await refreshCallingProvider();
    if (calling.provider !== 'retell') {
      try {
        await switchCallingProvider('retell');
        toast.success('Retell is now your calling provider.');
      } catch (e) {
        toast.error(retellMessage(e));
        return;
      }
    }
    onClose();
    setActiveView('ai_settings');
  };

  return (
    <Overlay onClose={onClose}>
      <RetellConnect status={status} onChange={onChange} onAgentReady={() => void openAgentSettings()} />
    </Overlay>
  );
};

/**
 * Retell, in the shape of the Telnyx card: what the connection can do now,
 * and one button into the setup overlay. Secrets are never printed.
 */
const RetellCard: React.FC<{ reloadKey: number; onChanged: () => void }> = ({ reloadKey, onChanged }) => {
  const [status, setStatus] = useState<RetellStatus | null>(null);
  const [sms, setSms] = useState<SmsCapability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    getRetellStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
        // Whether the number can text is Retell's to say, and only matters once Retell is the provider.
        if (s.active && s.smsAgentId) getRetellSms().then((r) => setSms(r.capability)).catch(() => setSms(null));
        else setSms(null);
      })
      .catch((e) => {
        setError(retellMessage(e));
        setStatus({ connected: false, active: false, apiKeyMasked: '', hasWebhookKey: false, agentId: '', smsAgentId: '', fromNumber: '', connectedAt: null });
      });
  }, []);
  useEffect(load, [load, reloadKey]);

  const loading = status === null;
  const connected = !!status?.connected;
  const voiceReady = !!status?.agentId && !!status?.fromNumber;

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-sky-600/20 text-sky-300 flex items-center justify-center border border-sky-500/30 shrink-0">
            <PhoneCall className="w-5 h-5" />
          </div>
        }
        title="Retell"
        blurb={connected ? (status!.active ? (sms?.available ? 'This agent calls and texts from your own Retell workspace' : 'This agent calls from your own Retell workspace') : 'Set up — in use once you switch to Retell above') : 'AI voice calls, and SMS, on your own Retell workspace'}
        connected={connected}
        loading={loading}
        accent="border-sky-500/40"
        action={{
          label: loading ? 'Checking connection…' : connected ? 'Manage connection' : 'Connect Retell',
          icon: connected ? <Settings2 className="w-4 h-4" /> : <Plus className="w-4 h-4" />,
          onClick: () => setOpen(true),
          className: 'bg-sky-600 hover:bg-sky-500 text-on-accent shadow-md shadow-sky-950',
        }}
      >
        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
            <div className="text-xs text-rose-200 leading-relaxed">{error}</div>
          </div>
        )}

        {loading ? (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Checking your Retell connection…
          </div>
        ) : connected ? (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1.5">
            <Fact label="From number" value={status!.fromNumber || 'none chosen'} mono />
            <div className="pt-1.5 mt-1.5 border-t border-slate-800/80 space-y-1">
              <Ok ok={status!.hasWebhookKey} yes="Webhook key saved" no="No webhook key — add it in Manage connection" />
              <Ok ok={voiceReady} yes="Voice calling ready" no={!status!.agentId ? 'No AI agent yet — create or pick one in Manage connection' : 'No number chosen for calls yet'} />
              {!status!.active ? (
                <Ok ok={!!status!.smsAgentId} yes="SMS agent set up — texts go through it once you switch to Retell" no="No SMS agent yet — set it up on AI Assistant settings once Retell is your calling provider" />
              ) : sms ? (
                <Ok ok={sms.available} yes={sms.state === 'unverified' ? 'SMS messaging ready (registration not verifiable through Retell)' : 'SMS messaging ready'} no={`SMS unavailable — ${sms.reason ?? 'not set up'}`} />
              ) : (
                <Ok ok={false} no="SMS not set up — set up the SMS agent on AI Assistant settings (SMS card)" yes="" />
              )}
            </div>
          </div>
        ) : (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
            The AI agent runs on <span className="text-slate-200">your own</span> Retell workspace. Add your API key and webhook key, pick or buy the number to
            call from, then create an agent or use one you already built — after that, prompt and voice are edited on AI Agent settings.
          </div>
        )}
      </IntegrationCard>

      {open && (
        <RetellConnectModal
          status={status!}
          onClose={() => setOpen(false)}
          onChange={() => {
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
};

/** Telnyx chosen while Retell is the provider: Telnyx accounts are connected and edited only while Telnyx is in use. */
const TelnyxAfterSwitch: React.FC<{ saved: boolean }> = ({ saved }) => (
  <section className={`${card} text-xs text-slate-300 leading-relaxed`}>
    {saved
      ? 'Your saved Telnyx account comes back as it was when you switch to Telnyx above.'
      : 'Switch to Telnyx above, then connect your Telnyx account here. Your organization calls through one provider at a time, so a Telnyx account is connected while Telnyx is the provider.'}
  </section>
);

/**
 * Settings → Calling (only where Retell is enabled): choose Telnyx or Retell,
 * like the calendar choice, and set up the chosen one. Choosing a card only
 * shows it; "Use … for calls" is what switches.
 */
export const CallingSettings: React.FC<{ initial?: CallingProviderName }> = ({ initial }) => {
  const [current, setCurrent] = useState<CallingProviderName | null>(null);
  const [choice, setChoice] = useState<CallingProviderName | null>(initial ?? null);
  const [saved, setSaved] = useState<Record<CallingProviderName, boolean>>({ telnyx: false, retell: false });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([getCallingProvider(), getTelnyxStatus().catch(() => null), getRetellStatus().catch(() => null)]).then(
      ([calling, telnyx, retell]) => {
        if (!live) return;
        setCurrent(calling.provider);
        setChoice((c) => c ?? calling.provider);
        setSaved({ telnyx: !!telnyx?.hasIntegration, retell: !!retell?.connected });
      },
    );
    return () => {
      live = false;
    };
  }, [reloadKey]);

  if (!current || !choice) {
    return (
      <div className={`${card} text-xs text-slate-400 flex items-center gap-2`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking which provider you call through…
      </div>
    );
  }

  const tagFor = (id: CallingProviderName) =>
    current === id
      ? { text: 'Current', className: 'text-emerald-400' }
      : saved[id]
        ? { text: id === 'retell' ? 'Set up' : 'Saved', className: 'text-slate-400' }
        : null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <section className={card}>
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ArrowLeftRight className="w-4 h-4 text-emerald-400" /> Calling provider
          </h3>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            Your organization calls through Telnyx or Retell, never both. Past calls keep the provider they were made with.
          </p>
        </div>

        <div role="radiogroup" aria-label="Calling provider" className="grid gap-2 sm:grid-cols-2">
          {(['telnyx', 'retell'] as const).map((id) => {
            const selected = id === choice;
            const tag = tagFor(id);
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setChoice(id)}
                className={`text-left rounded-xl border p-3 flex items-start gap-3 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
                  selected ? PROVIDER_CARDS[id].selected : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                }`}
              >
                <span className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${PROVIDER_CARDS[id].tone}`}>
                  <PhoneCall className="w-4 h-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs font-bold text-white">{PROVIDER_LABEL[id]}</span>
                    {tag && <span className={`text-2xs font-semibold ${tag.className}`}>{tag.text}</span>}
                  </span>
                  <span className="block text-2xs text-slate-400 mt-0.5 leading-relaxed">{PROVIDER_CARDS[id].tagline}</span>
                </span>
                <span
                  aria-hidden
                  className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                    selected ? 'border-emerald-400 bg-emerald-500' : 'border-slate-600'
                  }`}
                >
                  {selected && <Check className="w-2.5 h-2.5 text-slate-950" />}
                </span>
              </button>
            );
          })}
        </div>

        {choice !== current && (
          <>
            <p className="text-xs text-slate-300 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2 leading-relaxed">
              Switching to {PROVIDER_LABEL[choice]} makes it your calling provider. {PROVIDER_LABEL[current]} stays saved, so you can
              switch back without connecting again.
            </p>
            {choice === 'retell' && (
              <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Set up Retell below (keys, number and agent) before you switch. SMS is set up on AI Assistant settings once Retell is your
                calling provider; the review before switching says what will and will not be sent until then.
              </div>
            )}
            <SwitchBox to={choice} onSwitched={() => setReloadKey((k) => k + 1)} />
          </>
        )}
      </section>

      {choice === 'retell' ? (
        <RetellCard reloadKey={reloadKey} onChanged={() => setReloadKey((k) => k + 1)} />
      ) : current === 'telnyx' ? (
        <TelnyxCard key={reloadKey} />
      ) : (
        <TelnyxAfterSwitch saved={saved.telnyx} />
      )}
    </div>
  );
};

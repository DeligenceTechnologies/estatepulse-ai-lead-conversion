import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, CheckCircle2, KeyRound, Loader2, Phone, PhoneCall, Plus, Unplug } from 'lucide-react';
import { toast } from 'react-toastify';
import { confirmToast } from '../../lib/toast';
import { getTelnyxStatus } from '../../utils/assistantApi';
import { TelnyxCard } from './TelnyxCard';
import {
  PROVIDER_LABEL,
  SMS_UNAVAILABLE_ON_RETELL,
  getCallingProvider,
  getSwitchPreview,
  switchCallingProvider,
  type CallingProviderName,
  type SwitchPreview,
} from '../../utils/callingProviderApi';
import {
  assignRetellNumber,
  retellMessage,
  buyRetellNumber,
  connectRetell,
  createRetellAgent,
  disconnectRetell,
  getRetellStatus,
  importRetellNumber,
  listRetellNumbers,
  listRetellVoices,
  type RetellNumber,
  type RetellStatus,
  type RetellVoice,
} from '../../utils/retellApi';

/**
 * Settings → Calling, shown only when Retell is enabled on the server: which
 * provider the organization calls through (Telnyx or Retell), the switch, and
 * each provider's own setup. Retell is voice only: no SMS goes through it.
 */

const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4';
const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';
const primary =
  'px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer flex items-center gap-1.5 shrink-0';
const secondary =
  'px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-40 text-xs font-semibold cursor-pointer flex items-center gap-1.5 shrink-0';

const Ok: React.FC<{ ok: boolean; yes: string; no: string }> = ({ ok, yes, no }) => (
  <div className={`flex items-start gap-1.5 text-xs leading-relaxed ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
    {ok ? yes : no}
  </div>
);

const PROVIDER_CARDS: Record<CallingProviderName, { tagline: string; tone: string; selected: string }> = {
  telnyx: {
    tagline: 'AI calls and SMS on your own Telnyx account.',
    tone: 'bg-violet-600/20 text-violet-300 border-violet-500/30',
    selected: 'border-violet-500/60 bg-violet-500/[0.06]',
  },
  retell: {
    tagline: 'AI voice calls on your own Retell workspace. No SMS.',
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

/** API key + webhook key. Retell signs webhooks and tool calls only with the key carrying its “Webhook” badge. With onCancel it edits a connected account's keys. */
const ConnectForm: React.FC<{ onConnected: () => void; onCancel?: () => void }> = ({ onConnected, onCancel }) => {
  const [apiKey, setApiKey] = useState('');
  const [webhookKey, setWebhookKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await connectRetell(apiKey.trim(), webhookKey.trim());
      toast.success(onCancel ? 'Retell keys updated.' : s.workspace ? `Retell connected (${s.workspace}).` : 'Retell connected.');
      onConnected();
    } catch (e) {
      setError(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">API key</label>
        <input type="password" autoComplete="off" className={input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Webhook key</label>
        <input type="password" autoComplete="off" className={input} value={webhookKey} onChange={(e) => setWebhookKey(e.target.value)} />
        <p className="text-2xs text-slate-500 mt-1 leading-relaxed">
          In Retell → Settings → API Keys, copy the key with the “Webhook” badge next to it and paste it here. Retell signs
          its webhooks and booking-tool calls with that key only. It may be the same key as above.
        </p>
      </div>
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className={secondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="button" className={primary} disabled={busy || !apiKey.trim() || !webhookKey.trim()} onClick={() => void connect()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} {onCancel ? 'Save keys' : 'Connect Retell'}
        </button>
      </div>
    </div>
  );
};

const AgentSetup: React.FC<{ onCreated: () => void }> = ({ onCreated }) => {
  const [voices, setVoices] = useState<RetellVoice[] | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listRetellVoices()
      .then((v) => {
        setVoices(v);
        setVoiceId(v[0]?.id ?? '');
      })
      .catch((e) => {
        setVoices([]);
        toast.error(retellMessage(e));
      });
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      await createRetellAgent({ voiceId: voiceId || undefined });
      toast.success('Retell agent created. Edit its prompt and voice on AI Agent settings.');
      onCreated();
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[12rem]">
        <label className="block text-xs font-semibold text-slate-300 mb-1">Voice</label>
        <select className={input} value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!voices?.length}>
          {voices === null && <option>Loading voices…</option>}
          {voices?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.gender || v.accent ? ` (${[v.gender, v.accent].filter(Boolean).join(', ')})` : ''}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className={primary} disabled={busy || voices === null} onClick={() => void create()}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create agent
      </button>
    </div>
  );
};

/** Numbers on the Retell workspace: buy one (US/CA), bring one from a SIP trunk (not Telnyx), pick the one calls come from. */
const NumbersSection: React.FC<{ status: RetellStatus; onChange: () => void }> = ({ status, onChange }) => {
  const [numbers, setNumbers] = useState<RetellNumber[] | null>(null);
  const [areaCode, setAreaCode] = useState('');
  const [country, setCountry] = useState<'US' | 'CA'>('US');
  const [showImport, setShowImport] = useState(false);
  const [sip, setSip] = useState({ phoneNumber: '', terminationUri: '', username: '', password: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    listRetellNumbers()
      .then(setNumbers)
      .catch((e) => {
        setNumbers([]);
        toast.error(retellMessage(e));
      });
  }, []);
  useEffect(load, [load]);

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(done);
      load();
      onChange();
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const buy = () =>
    run(
      'buy',
      async () => {
        const n = await buyRetellNumber({ countryCode: country, ...(areaCode ? { areaCode: Number(areaCode) } : {}) });
        if (!status.fromNumber) await assignRetellNumber(n.phoneNumber);
      },
      'Number bought and routed to your agent.',
    );

  const importNumber = () =>
    run(
      'import',
      async () => {
        await importRetellNumber({
          phoneNumber: sip.phoneNumber.trim(),
          terminationUri: sip.terminationUri.trim(),
          ...(sip.username.trim() ? { username: sip.username.trim() } : {}),
          ...(sip.password ? { password: sip.password } : {}),
        });
        setSip({ phoneNumber: '', terminationUri: '', username: '', password: '' });
        setShowImport(false);
      },
      'Number imported and routed to your agent.',
    );

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
        <Phone className="w-3.5 h-3.5 text-emerald-400" /> Phone numbers
      </h4>
      {numbers === null ? (
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading numbers…
        </div>
      ) : numbers.length === 0 ? (
        <p className="text-xs text-slate-500">No numbers on this Retell workspace yet.</p>
      ) : (
        <ul className="space-y-1.5 list-none">
          {numbers.map((n) => (
            <li key={n.phoneNumber} className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
              <span className="text-xs font-mono text-slate-200 truncate">
                {n.phoneNumber}
                {n.nickname && <span className="text-slate-500 font-sans"> · {n.nickname}</span>}
              </span>
              {n.fromNumber ? (
                <span className="text-2xs font-bold uppercase text-emerald-300">Calls come from here</span>
              ) : (
                <button
                  type="button"
                  className={secondary}
                  disabled={!!busy}
                  onClick={() => void run(`assign:${n.phoneNumber}`, () => assignRetellNumber(n.phoneNumber), `Calls now come from ${n.phoneNumber}.`)}
                >
                  {busy === `assign:${n.phoneNumber}` && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Use for calls
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-2xs font-semibold text-slate-400 mb-1">Country</label>
          <select className={`${input} w-24`} value={country} onChange={(e) => setCountry(e.target.value as 'US' | 'CA')}>
            <option value="US">US</option>
            <option value="CA">Canada</option>
          </select>
        </div>
        <div>
          <label className="block text-2xs font-semibold text-slate-400 mb-1">Area code (optional)</label>
          <input className={`${input} w-28`} inputMode="numeric" maxLength={3} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))} />
        </div>
        <button type="button" className={primary} disabled={!!busy || (areaCode !== '' && areaCode.length !== 3)} onClick={() => void buy()}>
          {busy === 'buy' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Buy a number
        </button>
        <button type="button" className={secondary} onClick={() => setShowImport((v) => !v)}>
          Bring your own number
        </button>
      </div>
      <p className="text-2xs text-slate-500">Retell numbers cost about $2 a month, billed by Retell.</p>

      {showImport && (
        <div className="space-y-2 bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <p className="text-2xs text-slate-400 leading-relaxed">
            Import a number from your own SIP trunk (Telnyx, Twilio or another carrier) with its termination URI and SIP
            credentials.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input className={input} placeholder="+12025550123" value={sip.phoneNumber} onChange={(e) => setSip({ ...sip, phoneNumber: e.target.value })} />
            <input className={input} placeholder="Termination URI, e.g. sip.telnyx.com" value={sip.terminationUri} onChange={(e) => setSip({ ...sip, terminationUri: e.target.value })} />
            <input className={input} placeholder="SIP username (optional)" autoComplete="off" value={sip.username} onChange={(e) => setSip({ ...sip, username: e.target.value })} />
            <input className={input} type="password" placeholder="SIP password (optional)" autoComplete="off" value={sip.password} onChange={(e) => setSip({ ...sip, password: e.target.value })} />
          </div>
          <div className="flex justify-end">
            <button type="button" className={primary} disabled={!!busy || !sip.phoneNumber.trim() || !sip.terminationUri.trim()} onClick={() => void importNumber()}>
              {busy === 'import' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Import number
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const RetellAccountCard: React.FC<{ reloadKey: number }> = ({ reloadKey }) => {
  const [status, setStatus] = useState<RetellStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingKeys, setEditingKeys] = useState(false);

  const load = useCallback(() => {
    getRetellStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(retellMessage(e)));
  }, []);
  useEffect(load, [load, reloadKey]);

  const disconnect = async () => {
    if (!(await confirmToast('Disconnect this Retell account? Its keys are removed from EstatePulse; nothing in Retell is deleted.', 'Disconnect'))) return;
    try {
      setStatus(await disconnectRetell());
      toast.success('Retell disconnected.');
    } catch (e) {
      toast.error(retellMessage(e));
    }
  };

  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-sky-600/20 text-sky-300 flex items-center justify-center border border-sky-500/30 shrink-0">
            <PhoneCall className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white">Retell</h3>
            <p className="text-xs text-slate-400">AI voice calls on your own Retell workspace (no SMS)</p>
          </div>
        </div>
        {status?.connected && !editingKeys && (
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" className={secondary} onClick={() => setEditingKeys(true)}>
              <KeyRound className="w-3.5 h-3.5" /> Update keys
            </button>
            {!status.active && (
              <button type="button" className={secondary} onClick={() => void disconnect()}>
                <Unplug className="w-3.5 h-3.5" /> Disconnect
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex items-start gap-2 text-2xs text-slate-400 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
        Retell places outbound calls only after your workspace’s KYC (identity check) is complete in the Retell dashboard.
      </div>

      {!status ? (
        !error && (
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking your Retell connection…
          </div>
        )
      ) : !status.connected ? (
        <ConnectForm onConnected={load} />
      ) : editingKeys ? (
        <ConnectForm
          onConnected={() => {
            setEditingKeys(false);
            load();
          }}
          onCancel={() => setEditingKeys(false)}
        />
      ) : (
        <div className="space-y-4">
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1">
            <Ok ok={status.active} yes="Your organization calls through Retell" no="Set up — not in use until you switch to Retell above" />
            <Ok ok={status.hasWebhookKey} yes="Webhook key saved" no="No webhook key — add it with Update keys" />
            <Ok ok={!!status.agentId} yes="AI agent created" no="No agent yet — create one below" />
            <Ok ok={!!status.fromNumber} yes={`Calls come from ${status.fromNumber}`} no="No number chosen for calls yet" />
          </div>
          {!status.agentId ? <AgentSetup onCreated={load} /> : <NumbersSection status={status} onChange={load} />}
        </div>
      )}
    </section>
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
                {SMS_UNAVAILABLE_ON_RETELL} SMS steps in your strategy and sequences will not be sent. Set up Retell below before you
                switch.
              </div>
            )}
            <SwitchBox to={choice} onSwitched={() => setReloadKey((k) => k + 1)} />
          </>
        )}
      </section>

      {choice === 'retell' ? (
        <RetellAccountCard reloadKey={reloadKey} />
      ) : current === 'telnyx' ? (
        <TelnyxCard key={reloadKey} />
      ) : (
        <TelnyxAfterSwitch saved={saved.telnyx} />
      )}
    </div>
  );
};

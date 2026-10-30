import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, KeyRound, Link2, Loader2, Pencil, Plus, Sparkles } from 'lucide-react';
import { toast } from 'react-toastify';
import { refreshCallingProvider } from '../../utils/callingProviderApi';
import {
  assignRetellNumber,
  buyRetellNumber,
  connectRetell,
  createRetellAgent,
  disableRetellSms,
  disconnectRetell,
  getRetellSms,
  importRetellNumber,
  listRetellAgents,
  listRetellNumbers,
  retellMessage,
  setupRetellSms,
  unassignRetellNumber,
  useRetellAgent,
  type RetellAgentSummary,
  type RetellNumber,
  type RetellSmsStatus,
  type RetellStatus,
} from '../../utils/retellApi';

/**
 * Bring-Your-Own-Retell, in the same shape as the Telnyx panel: keys (each
 * replaceable on its own once saved), the number calls come from (read from
 * the workspace as soon as the keys verify; bought or brought in when there is
 * none) and the voice agent (ours with default settings, or one already built
 * in the Retell dashboard). SMS (RetellSmsSection) lives on AI Agent settings.
 * Everything here is saved on Retell itself: the agent is created there, and
 * its prompt and settings are edited there.
 */

const input =
  'w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500';
const primary =
  'px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer flex items-center gap-1.5 shrink-0';
const secondary =
  'px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-40 text-xs font-semibold cursor-pointer flex items-center gap-1.5 shrink-0';

/** A workspace number's kind, as Retell reports it, in words. */
const NUMBER_TYPE: Record<string, string> = { 'retell-twilio': 'Retell (Twilio) number', 'retell-telnyx': 'Retell (Telnyx) number', custom: 'number brought in over SIP' };

const Step: React.FC<{ n: number; title: string; right?: React.ReactNode }> = ({ n, title, right }) => (
  <div className="flex items-center gap-2">
    <span className="w-5 h-5 rounded-full bg-emerald-600/20 text-emerald-400 text-xs font-bold flex items-center justify-center">{n}</span>
    <span className="text-xs font-semibold text-slate-200">{title}</span>
    {right}
  </div>
);

export const Ok: React.FC<{ ok: boolean; yes: string; no: string }> = ({ ok, yes, no }) => (
  <div className={`flex items-start gap-1.5 text-xs leading-relaxed ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
    {ok ? yes : no}
  </div>
);

/** A key on file reads as saved and verified, and turns back into an input only when you ask to replace it. */
const KeyField: React.FC<{
  label: string;
  saved: boolean;
  value: string;
  onChange: (v: string) => void;
  hint?: React.ReactNode;
}> = ({ label, saved, value, onChange, hint }) => {
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setReplacing(false), [saved]);
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-300 mb-1">
        {label} {!saved && <span className="text-rose-400 font-normal">* required</span>}
      </label>
      {saved && !replacing ? (
        <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="text-white truncate">{label} saved and verified</span>
          <button type="button" onClick={() => setReplacing(true)} className="ml-auto text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1 shrink-0 cursor-pointer">
            <Pencil className="w-3 h-3" /> Replace
          </button>
        </div>
      ) : (
        <>
          <input type="password" autoComplete="off" autoFocus={replacing} className={`${input} font-mono`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="key_…" />
          {saved && (
            <button
              type="button"
              onClick={() => {
                setReplacing(false);
                onChange('');
              }}
              className="text-2xs text-slate-400 hover:text-slate-200 mt-1.5 cursor-pointer"
            >
              Cancel — keep the key already on file
            </button>
          )}
        </>
      )}
      {hint && <p className="text-2xs text-slate-500 mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
};

/**
 * The numbers on the Retell workspace, read as soon as the keys are on file:
 * pick the one calls come from, or, when there is none, buy one (US or
 * Canada) or bring one in from a SIP trunk.
 */
export const RetellNumbers: React.FC<{ status: RetellStatus; onChange: () => void }> = ({ status, onChange }) => {
  const [numbers, setNumbers] = useState<RetellNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [areaCode, setAreaCode] = useState('');
  const [country, setCountry] = useState<'US' | 'CA'>('US');
  const [showBuy, setShowBuy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [sip, setSip] = useState({ phoneNumber: '', terminationUri: '', username: '', password: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    listRetellNumbers()
      .then((n) => {
        setNumbers(n);
        setError(null);
        // Nothing to pick from: the ways to get a number are the whole form.
        if (n.length === 0) setShowBuy(true);
      })
      .catch((e) => {
        setNumbers([]);
        setError(retellMessage(e));
      });
  }, []);
  useEffect(load, [load, status.fromNumber, status.apiKeyMasked]);

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
        setShowBuy(false);
      },
      status.fromNumber ? 'Number bought.' : 'Number bought; calls come from it now.',
    );

  const importNumber = () =>
    run(
      'import',
      async () => {
        const n = await importRetellNumber({
          phoneNumber: sip.phoneNumber.trim(),
          terminationUri: sip.terminationUri.trim(),
          ...(sip.username.trim() ? { username: sip.username.trim() } : {}),
          ...(sip.password ? { password: sip.password } : {}),
        });
        if (!status.fromNumber) await assignRetellNumber(n.phoneNumber);
        setSip({ phoneNumber: '', terminationUri: '', username: '', password: '' });
        setShowImport(false);
      },
      status.fromNumber ? 'Number imported.' : 'Number imported; calls come from it now.',
    );

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      {numbers === null ? (
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the numbers on your Retell workspace…
        </div>
      ) : numbers.length === 0 ? (
        <p className="text-xs text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> This Retell workspace has no phone numbers yet — buy one or bring your own below.
        </p>
      ) : (
        <ul className="space-y-1.5 list-none">
          {numbers.map((n) => (
            <li key={n.phoneNumber} className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
              <span className="text-xs font-mono text-slate-200 truncate">
                {n.phoneNumber}
                <span className="text-slate-500 font-sans"> · {NUMBER_TYPE[n.type] ?? n.type}</span>
              </span>
              {n.fromNumber ? (
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-2xs font-bold uppercase text-emerald-300 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Calls come from here
                  </span>
                  <button
                    type="button"
                    className="text-xs font-semibold text-rose-400 hover:text-rose-300 disabled:opacity-40 cursor-pointer"
                    disabled={!!busy}
                    onClick={() => void run('unassign', unassignRetellNumber, 'Number cleared — pick the one calls come from.')}
                  >
                    {busy === 'unassign' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Change'}
                  </button>
                </span>
              ) : (
                <button type="button" className={secondary} disabled={!!busy} onClick={() => void run(`assign:${n.phoneNumber}`, () => assignRetellNumber(n.phoneNumber), `Calls now come from ${n.phoneNumber}.`)}>
                  {busy === `assign:${n.phoneNumber}` && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Use for calls
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={() => setShowBuy((v) => !v)}>
          {showBuy ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Buy a number
        </button>
        <button type="button" className={secondary} onClick={() => setShowImport((v) => !v)}>
          {showImport ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Bring your own number
        </button>
      </div>

      {showBuy && (
        <div className="space-y-2 bg-slate-950/60 border border-slate-800 rounded-xl p-3">
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
          </div>
          <p className="text-2xs text-slate-500">Retell numbers cost about $2 a month, billed by Retell. A Retell (Twilio) US number is the only kind that can text.</p>
        </div>
      )}

      {showImport && (
        <div className="space-y-2 bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <p className="text-2xs text-slate-400 leading-relaxed">
            Import a number from your own SIP trunk (Telnyx, Twilio or another carrier) with its termination URI and SIP credentials. Calls only: a
            number brought in over SIP cannot text through Retell.
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

/**
 * The voice agents on the Retell workspace. `autoSwitch` makes choosing one
 * adopt it at once (the "Editing agent" control); otherwise the choice waits
 * for a button. Only single-prompt agents can be adopted; the server says so.
 */
export const RetellAgentSelect: React.FC<{ status: RetellStatus; onChange: () => void; autoSwitch?: boolean }> = ({ status, onChange, autoSwitch }) => {
  const [agents, setAgents] = useState<RetellAgentSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);

  // Read only once the keys are on file, and again whenever they or the agent change: a read
  // from before the keys were saved must never leave a stale "connect first" behind.
  useEffect(() => {
    if (!status.connected) {
      setAgents(null);
      setListError(null);
      return;
    }
    let live = true;
    listRetellAgents()
      .then((a) => {
        if (!live) return;
        setAgents(a);
        setListError(null);
      })
      .catch((e) => {
        if (!live) return;
        // A failed read is said as such, never as an empty workspace.
        setAgents([]);
        setListError(retellMessage(e));
      });
    return () => {
      live = false;
    };
  }, [status.connected, status.apiKeyMasked, status.agentId]);

  const adopt = async (agentId: string) => {
    if (!agentId || agentId === status.agentId) return;
    setBusy(true);
    try {
      await useRetellAgent(agentId);
      toast.success('Retell agent in use. Its prompt and voice are edited on AI Agent settings.');
      setChoice('');
      onChange();
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status.connected) return <span className="text-xs text-slate-500">Verify your keys first; the agents on your workspace are read then.</span>;
  if (agents === null) {
    return (
      <span className="text-xs text-slate-500 flex items-center gap-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your agents…
      </span>
    );
  }
  if (listError) {
    return (
      <span className="text-xs text-rose-300 flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> Could not read your agents: {listError}
      </span>
    );
  }
  if (agents.length === 0) return <span className="text-xs text-slate-500">No voice agents on this Retell workspace yet.</span>;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
      <select
        className={`bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-emerald-500 min-w-0 ${autoSwitch ? 'max-w-[260px]' : 'flex-1 basis-40'}`}
        value={autoSwitch ? status.agentId : choice}
        disabled={busy}
        onChange={(e) => (autoSwitch ? void adopt(e.target.value) : setChoice(e.target.value))}
      >
        {!autoSwitch && <option value="">Choose an agent…</option>}
        {autoSwitch && status.agentId && !agents.some((a) => a.agentId === status.agentId) && <option value={status.agentId}>{status.agentId}</option>}
        {agents.map((a) => (
          <option key={a.agentId} value={a.agentId}>
            {a.name}
            {a.current ? ' (in use)' : ''}
          </option>
        ))}
      </select>
      {!autoSwitch && (
        <button type="button" className={secondary} disabled={busy || !choice || choice === status.agentId} onClick={() => void adopt(choice)}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Use this agent
        </button>
      )}
      {autoSwitch && busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
    </div>
  );
};

/** Name it, and a ready-to-use qualifier agent is created on the workspace; voice, prompt and the rest are edited on AI Agent settings. */
const CreateAgent: React.FC<{ onCreated: () => void }> = ({ onCreated }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await createRetellAgent({ name: name.trim() });
      toast.success('Retell agent created on your workspace. Its voice and prompt are edited on AI Agent settings.');
      onCreated();
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name (e.g. Austin Home Advisors)" maxLength={100} />
      <button type="button" className={primary} disabled={busy || !name.trim()} onClick={() => void create()}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Create agent
      </button>
    </div>
  );
};

/** Whether texts can go through Retell from the calling number, and the one-click setup of the SMS agent. */
export const RetellSmsSection: React.FC<{ status: RetellStatus; onChange: () => void }> = ({ status, onChange }) => {
  const [sms, setSms] = useState<RetellSmsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getRetellSms()
      .then((s) => {
        setSms(s);
        setError(null);
      })
      .catch((e) => setError(retellMessage(e)));
  }, []);
  useEffect(load, [load, status.fromNumber, status.smsAgentId, status.active]);

  const run = async (action: () => Promise<RetellSmsStatus>, done: string) => {
    setBusy(true);
    try {
      setSms(await action());
      setError(null);
      toast.success(done);
      // Every screen's idea of what Retell can send comes from the server: ask it again.
      void refreshCallingProvider();
      onChange();
    } catch (e) {
      setError(retellMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cap = sms?.capability;
  const numberType = sms?.number ? (NUMBER_TYPE[sms.number.type] ?? null) : null;
  const canSetUp = !!status.fromNumber && !!status.agentId && cap?.state !== 'unsupported_number';
  // Before the switch the capability reads "not in use"; what the owner needs then is whether the number can text at all.
  const notInUse = !status.active && cap?.state === 'unavailable';

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      {!sms ? (
        !error && (
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking whether {status.fromNumber || 'your number'} can text…
          </div>
        )
      ) : (
        <div className="space-y-2">
          {cap && !notInUse && (
            <Ok
              ok={cap.available}
              yes={cap.state === 'unverified' ? `SMS agent set up on ${sms.fromNumber} — registration not verifiable` : `Texts go through Retell from ${sms.fromNumber}`}
              no={cap.reason ?? 'SMS is not available on Retell.'}
            />
          )}
          {notInUse && <Ok ok={!!status.smsAgentId} yes={`SMS agent set up on ${sms.fromNumber}; texts go through it once you switch to Retell`} no="No SMS agent yet — set it up below so texts work once you switch to Retell" />}
          {cap?.state === 'unverified' && <p className="text-2xs text-slate-400 leading-relaxed">{sms.registrationNote}</p>}
          {numberType && <p className="text-2xs text-slate-500">{sms.fromNumber} is a {numberType}.</p>}
          {sms.numberError && <p className="text-2xs text-amber-300">Could not read the number from Retell: {sms.numberError}</p>}
          <p className="text-2xs text-slate-500 leading-relaxed">
            Retell SMS needs a Retell (Twilio) US number, not toll-free, with the SMS add-on approved in the Retell dashboard (A2P 10DLC registration,
            2–3 weeks). A number brought in from Telnyx cannot text through Retell. Each SMS step is sent as written; the SMS agent answers replies,
            and Retell does not report delivery per message.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} disabled={busy || !canSetUp} onClick={() => void run(setupRetellSms, status.smsAgentId ? 'SMS setup checked.' : 'SMS set up on Retell.')}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} {status.smsAgentId ? 'Check SMS setup' : 'Set up SMS'}
            </button>
            {status.smsAgentId && (
              <button type="button" className={secondary} disabled={busy} onClick={() => void run(disableRetellSms, 'SMS turned off on Retell.')}>
                Turn SMS off
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The whole setup, in the overlay the Telnyx card opens. `onAgentReady` runs
 * the moment an agent is created or adopted: the owner is taken to AI Agent
 * settings, where the prompt, voice, number and SMS live.
 */
export const RetellConnect: React.FC<{ status: RetellStatus; onChange: () => void; onAgentReady?: () => void }> = ({ status, onChange, onAgentReady }) => {
  const [apiKey, setApiKey] = useState('');
  const [webhookKey, setWebhookKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (done) toast.success(done);
      onChange();
    } catch (e) {
      setError(retellMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveKeys = () =>
    run(
      'keys',
      async () => {
        const s = await connectRetell({ apiKey: apiKey.trim() || undefined, webhookKey: webhookKey.trim() || undefined });
        setApiKey('');
        setWebhookKey('');
        toast.success(status.connected ? 'Retell keys updated.' : s.workspace ? `Retell connected (${s.workspace}).` : 'Retell connected.');
      },
    );

  const canSave = status.connected ? !!(apiKey.trim() || webhookKey.trim()) : !!(apiKey.trim() && webhookKey.trim());

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-emerald-400" />
          {status.connected ? 'Your Retell connection' : 'Connect your Retell account'}
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          EstatePulse runs the AI agent on <span className="text-slate-300">your own</span> Retell workspace: the agent is created there and every change you
          make here is saved there.{' '}
          <a href="https://dashboard.retellai.com" target="_blank" rel="noreferrer" className="text-emerald-400 underline">
            dashboard.retellai.com
          </a>
        </p>
      </div>

      <div className="flex items-start gap-2 text-2xs text-slate-400 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
        Retell places outbound calls only after your workspace’s KYC (identity check) is complete in the Retell dashboard.
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {/* Step 1 — keys and the number */}
      <div className="space-y-3">
        <Step
          n={1}
          title="API credentials"
          right={
            status.connected &&
            (status.active ? (
              <span className="ml-auto text-2xs text-slate-500">Switch to Telnyx before disconnecting</span>
            ) : (
              <button type="button" disabled={busy !== null} onClick={() => void run('disconnect', disconnectRetell, 'Retell disconnected.')} className="ml-auto text-xs text-rose-400 hover:text-rose-300 font-semibold disabled:opacity-50 cursor-pointer">
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            ))
          }
        />
        <div className="space-y-3 pl-7">
          <KeyField label="API key" saved={status.connected} value={apiKey} onChange={setApiKey} hint="Any API key of the workspace: it places calls, creates the agent and reads your numbers." />
          <KeyField
            label="Webhook key"
            saved={status.connected && status.hasWebhookKey}
            value={webhookKey}
            onChange={setWebhookKey}
            hint="In Retell → Settings → API Keys, copy the key with the “Webhook” badge next to it. Retell signs its webhooks and tool calls with that key only. It may be the same key as above."
          />
          <button type="button" className={primary} disabled={busy !== null || !canSave} onClick={() => void saveKeys()}>
            {busy === 'keys' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            {status.connected ? 'Verify & save keys' : 'Verify & connect'}
          </button>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              From Number <span className="text-rose-400 font-normal">* required</span>
            </label>
            {status.connected ? (
              <RetellNumbers status={status} onChange={onChange} />
            ) : (
              <p className="text-xs text-slate-500 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2">Verify your keys first; the numbers on your workspace are read then.</p>
            )}
            <p className="text-2xs text-slate-500 mt-1">The Retell number calls are placed from. Required to dial leads.</p>
          </div>
        </div>
      </div>

      {/* Step 2 — agent */}
      <div className={`space-y-3 ${status.connected ? '' : 'opacity-40 pointer-events-none'}`}>
        <Step n={2} title="AI voice agent" />
        <div className="pl-7 space-y-3">
          {status.agentId ? (
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-emerald-400 flex items-center gap-1.5 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Agent in use:
                </span>
                <RetellAgentSelect status={status} onChange={onChange} autoSwitch />
              </div>
              <p className="text-2xs text-slate-500">Prompt, greeting and voice are edited on AI Agent settings. Pick another agent above to switch.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-2">
                <p className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Create with default settings
                </p>
                <p className="text-xs text-slate-400">Name it, and we create a ready-to-use real-estate qualifier agent on your Retell workspace.</p>
                <CreateAgent
                  onCreated={() => {
                    onChange();
                    onAgentReady?.();
                  }}
                />
              </div>
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-2">
                <p className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-cyan-400" /> Use an existing agent
                </p>
                <p className="text-xs text-slate-400">Already built one in the Retell dashboard? Single-prompt agents can be used as they are.</p>
                <RetellAgentSelect
                  status={status}
                  onChange={() => {
                    onChange();
                    onAgentReady?.();
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

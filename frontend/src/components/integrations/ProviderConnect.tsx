import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  AlertTriangle,
  Sparkles,
  Link2,
  CheckCircle2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  ExternalLink,
  Lock,
  ShieldCheck,
  Bot,
  PhoneCall,
  RefreshCw,
  Info,
} from 'lucide-react';
import { toast } from 'react-toastify';
import {
  TelnyxStatus,
  TelnyxCredentials,
  TelnyxAccount,
  AssistantSummary,
  saveTelnyxCredentials,
  addTelnyxAccount,
  listTelnyxAccounts,
  listAssistants,
  createAssistant,
  attachAssistant,
  reconnectTelnyx,
  disconnectTelnyx,
} from '../../utils/assistantApi';
import { TelnyxAccounts } from './TelnyxAccounts';
import { useApp } from '../../context/AppContext';
import { FromNumberSelect, useNumberLookup } from './FromNumberSelect';
import { RichSelect } from './RichSelect';
import { IconButton, Button } from '../common/Button';

const input =
  'w-full h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-sm text-white placeholder:text-slate-600 transition-colors focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15';

/** Where each key lives in the Telnyx portal. */
const API_KEY_PATH = 'Telnyx → Account Settings → API Keys';
const PUBLIC_KEY_PATH = 'Telnyx → Account Settings → API Keys → Public Key';

/** A labelled form field with an optional one-line hint. */
const Field: React.FC<{ label: string; required?: boolean; hint?: React.ReactNode; children: React.ReactNode }> = ({
  label,
  required,
  hint,
  children,
}) => (
  <div className="min-w-0">
    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-200 mb-1.5">
      {label}
      {required && <span className="text-rose-400" aria-label="required">*</span>}
    </label>
    {children}
    {hint && <div className="text-2xs text-slate-400 mt-1.5 leading-relaxed">{hint}</div>}
  </div>
);

/** A portal path, shown as breadcrumb chips so it reads at a glance. */
const PortalPath: React.FC<{ path: string }> = ({ path }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    {path.split(' → ').map((part, i) => (
      <React.Fragment key={part}>
        {i > 0 && <ChevronRight className="w-3 h-3 text-slate-600" />}
        <span className="px-1.5 py-0.5 rounded-md bg-slate-800/80 border border-slate-700/60 text-slate-300 font-medium">{part}</span>
      </React.Fragment>
    ))}
  </span>
);

/** Where the public key lives, and why it is asked for, on one line. */
const PublicKeyHint: React.FC = () => (
  <span className="inline-flex flex-wrap items-center gap-2">
    <PortalPath path={PUBLIC_KEY_PATH} />
    <span className="inline-flex items-center gap-1 text-slate-500">
      <Info className="w-3 h-3 shrink-0" /> Confirms call and SMS events really come from Telnyx. Not a secret.
    </span>
  </span>
);

type Tab = 'connect' | 'assistant';

/** API key input with its Verify button beside it, and what the check found below. */
const ApiKeyInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onVerify: () => void;
  verifying: boolean;
  verified: boolean;
  error: string | null;
  count?: number;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}> = ({ value, onChange, onVerify, verifying, verified, error, count, autoFocus, trailing }) => (
  <div className="space-y-1.5">
    <div className="flex items-center gap-2">
      <div className="relative flex-1 min-w-0">
        <input
          type="password"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim() && !verified) {
              e.preventDefault();
              onVerify();
            }
          }}
          placeholder="KEY0123…"
          className={`${input} font-mono pr-9 ${verified ? 'border-green-500/50' : error ? 'border-rose-500/50' : ''}`}
        />
        {verified && <CheckCircle2 className="w-4 h-4 text-green-400 absolute right-3 top-1/2 -translate-y-1/2" />}
      </div>
      <Button
        variant={verified ? 'outline' : 'primary'}
        className="h-11!"
        disabled={!value.trim() || verifying || verified}
        loading={verifying}
        icon={verified ? <CheckCircle2 /> : <ShieldCheck />}
        onClick={onVerify}
      >
        {verifying ? 'Verifying…' : verified ? 'Verified' : 'Verify'}
      </Button>
      {trailing}
    </div>
    {verified && count !== undefined && (
      <p className="text-2xs text-green-400 flex items-center gap-1.5">
        <CheckCircle2 className="w-3 h-3" /> Key works · {count} {count === 1 ? 'number' : 'numbers'} found on this account
      </p>
    )}
    {error && (
      <p className="text-2xs text-rose-400 flex items-start gap-1.5">
        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {error}
      </p>
    )}
  </div>
);

/** Shown where the number picker will appear, so nobody hunts for it. */
const NumberLocked: React.FC = () => (
  <div className="h-11 rounded-xl border border-dashed border-slate-800 bg-slate-950/40 px-3.5 flex items-center gap-2 text-xs text-slate-500">
    <Lock className="w-3.5 h-3.5 shrink-0" /> Verify your API key to choose a number
  </div>
);

/**
 * Bring-Your-Own-Telnyx: enter credentials, then create or attach an assistant.
 *
 * An org can keep several Telnyx accounts on file and switch between them, so
 * this panel edits *the account in use* and lists the rest below. Adding is a
 * separate act from editing on purpose, so a second key never silently
 * overwrites the first.
 */
export const ProviderConnect: React.FC<{ status: TelnyxStatus; onChange: () => void; onClose?: () => void }> = ({
  status,
  onChange,
  onClose,
}) => {
  const [apiKey, setApiKey] = useState('');
  // A stored key is encrypted and can never be shown again, so the field reports
  // what is on file and only turns back into an input when you ask to replace it.
  const [replacingKey, setReplacingKey] = useState(false);
  // Not a secret — it is what Telnyx signs its webhooks with, so it is shown plainly.
  const [publicKey, setPublicKey] = useState('');
  const [fromNumber, setFromNumber] = useState(status.fromNumber || '');
  const [label, setLabel] = useState(status.label || '');
  // Both ids are detected from the API key, so they are an override, not a
  // question — folded away unless someone actually needs to pin a specific pair.
  const [advanced, setAdvanced] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [messagingProfileId, setMessagingProfileId] = useState('');
  const [assistantName, setAssistantName] = useState('');
  const { setActiveView } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  // A connected account with no assistant yet opens on the step still to do.
  const [tab, setTab] = useState<Tab>(status.connected && !status.hasAssistant ? 'assistant' : 'connect');

  // The assistants already on the Telnyx account, for "use one you already have".
  const [assistants, setAssistants] = useState<AssistantSummary[] | null>(null);
  const [assistantsError, setAssistantsError] = useState<string | null>(null);
  const [assistantPick, setAssistantPick] = useState('');
  const [pasteId, setPasteId] = useState(false);
  const [assistantId, setAssistantId] = useState('');

  // The shelf of saved accounts, and the separate form for putting a new one on it.
  const [accounts, setAccounts] = useState<TelnyxAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newPublicKey, setNewPublicKey] = useState('');
  const [newFrom, setNewFrom] = useState('');

  const lookup = useNumberLookup();
  const newLookup = useNumberLookup();

  const loadAccounts = useCallback(() => {
    listTelnyxAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  const loadAssistants = useCallback(() => {
    if (!status.connected) {
      setAssistants(null);
      return;
    }
    setAssistantsError(null);
    listAssistants()
      .then(setAssistants)
      .catch((e: any) => {
        setAssistants([]);
        setAssistantsError(e?.message || 'Could not load your assistants.');
      });
  }, [status.connected, status.accountId]);

  useEffect(loadAccounts, [loadAccounts]);
  useEffect(loadAssistants, [loadAssistants]);

  // Every mutation moves both the status the parent holds and the shelf here.
  const refresh = () => {
    onChange();
    loadAccounts();
    loadAssistants();
  };

  const run = async (key: string, fn: () => Promise<any>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      refresh();
      if (done) toast.success(done);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  // The active account changes under us when someone switches on the shelf, so
  // the edit fields follow it rather than keeping the previous account's values.
  useEffect(() => {
    setFromNumber(status.fromNumber || '');
    setLabel(status.label || '');
    setApiKey('');
    setPublicKey('');
    setReplacingKey(false);
  }, [status.accountId, status.fromNumber, status.label]);

  // A stored key already works, so its numbers are read straight away.
  const { verify, reset } = lookup;
  useEffect(() => {
    if (status.connected) void verify();
    else reset();
  }, [status.connected, status.accountId, verify, reset]);

  useEffect(() => {
    setAssistantPick(status.assistantId || '');
  }, [status.assistantId]);

  // Disconnecting locks step 2 again, so do not leave it on screen.
  useEffect(() => {
    if (!status.connected) setTab('connect');
  }, [status.connected]);

  const usingStored = status.connected && !replacingKey;
  const keyVerified = usingStored
    ? lookup.verifiedFor === ''
    : !!apiKey.trim() && lookup.verifiedFor === apiKey.trim();
  const newKeyVerified = !!newApiKey.trim() && newLookup.verifiedFor === newApiKey.trim();

  const missing = [
    !keyVerified && (usingStored ? 'A working API key' : 'Verified API key'),
    !status.hasPublicKey && !publicKey.trim() && 'Public key',
    keyVerified && !fromNumber.trim() && 'From number',
  ].filter(Boolean) as string[];

  const assistantOptions = (assistants ?? []).map((a) => ({
    value: a.id,
    label: a.name || 'Untitled assistant',
    sublabel: [a.model, a.id].filter(Boolean).join(' · '),
    badge: a.id === status.assistantId ? 'Attached' : undefined,
  }));
  const attachTarget = assistantId.trim();
  const attachedName = assistants?.find((a) => a.id === status.assistantId)?.name;

  // Picking from the list is the attach: there is no second button to forget.
  const pickAssistant = async (id: string) => {
    if (!id || id === status.assistantId || busy !== null) return;
    const name = assistants?.find((a) => a.id === id)?.name || 'Assistant';
    setAssistantPick(id);
    setBusy('attach');
    try {
      await attachAssistant(id);
      refresh();
      toast.success(`${name} attached. Your agent now uses it.`);
    } catch (e: any) {
      // Show what is really attached, not the choice that failed.
      setAssistantPick(status.assistantId || '');
      toast.error(e?.message || 'Could not attach that assistant.');
    } finally {
      setBusy(null);
    }
  };

  const tabs: Array<{ id: Tab; name: string; done: boolean; locked: boolean }> = [
    { id: 'connect', name: 'Connect account', done: status.connected, locked: false },
    { id: 'assistant', name: 'AI assistant', done: status.hasAssistant, locked: !status.connected },
  ];

  const save = () =>
    run('save', () => {
      const firstConnect = !status.connected;
      const payload: TelnyxCredentials = { fromNumber, label };
      if (apiKey && !usingStored) payload.apiKey = apiKey.trim();
      if (publicKey.trim()) payload.publicKey = publicKey.trim();
      // Overrides only travel when Advanced is open and filled in. Echoing the stored ids back would pin the
      // connection to them and stop the server re-detecting — which is how a stale id survives a re-save.
      if (advanced && connectionId.trim()) payload.connectionId = connectionId.trim();
      if (advanced && messagingProfileId.trim()) payload.messagingProfileId = messagingProfileId.trim();
      return saveTelnyxCredentials(payload).then((r) => {
        toast.success('Telnyx settings saved.');
        setApiKey('');
        setPublicKey('');
        setReplacingKey(false);
        // The next thing a first-time setup needs is an assistant, so go straight there.
        if (firstConnect && r?.connected && !r.hasAssistant) setTab('assistant');
        return r;
      });
    });

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-full min-h-0">
      {/* Header — stays put while the body scrolls. */}
      <div className="shrink-0 px-5 pt-4 border-b border-slate-800 bg-gradient-to-br from-emerald-500/10 via-slate-900 to-violet-500/10">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/25 to-violet-500/25 border border-emerald-500/30 flex items-center justify-center shrink-0 shadow-lg shadow-emerald-500/10">
            <PhoneCall className="w-4 h-4 text-emerald-300" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-white leading-tight truncate">
              {status.connected ? status.label || 'Your Telnyx connection' : 'Connect your Telnyx account'}
            </h3>
            <p className="text-2xs text-slate-400 mt-0.5 truncate">
              {status.connected
                ? 'Change the number, swap the key, or pick another AI assistant.'
                : 'Your AI agent calls and texts through your own Telnyx account. About 2 minutes.'}
            </p>
          </div>
          <a
            href="https://portal.telnyx.com"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 shrink-0"
          >
            Telnyx portal <ExternalLink className="w-3.5 h-3.5" />
          </a>
          {onClose && <IconButton onClick={onClose} aria-label="Close" icon={<X />} />}
        </div>

        {/* Tabs: one step on screen at a time keeps the dialog short. */}
        <div className="mt-3 flex items-end gap-1" role="tablist">
          {tabs.map((t, i) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={t.locked}
                title={t.locked ? 'Connect your account first' : undefined}
                onClick={() => setTab(t.id)}
                className={`px-3 pb-2.5 pt-1 -mb-px border-b-2 text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer disabled:cursor-not-allowed ${
                  active ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200 disabled:hover:text-slate-400'
                } ${t.locked ? 'opacity-50' : ''}`}
              >
                <span
                  className={`w-5 h-5 rounded-full text-2xs font-bold flex items-center justify-center border ${
                    t.done
                      ? 'bg-green-500/15 text-green-300 border-green-500/30'
                      : active
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {t.done ? <CheckCircle2 className="w-3 h-3" /> : t.locked ? <Lock className="w-2.5 h-2.5" /> : i + 1}
                </span>
                {t.name}
              </button>
            );
          })}

          {status.connected && (
            <div className="ml-auto hidden md:flex items-center gap-1.5 pb-2.5 text-2xs font-semibold">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-300 border border-green-500/25">
                <CheckCircle2 className="w-3 h-3" /> Calls
              </span>
              {status.hasMessaging ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-300 border border-green-500/25">
                  <CheckCircle2 className="w-3 h-3" /> Texts
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/25"
                  title="Assign your number to a Telnyx Messaging Profile to enable texting."
                >
                  <AlertTriangle className="w-3 h-3" /> Texts off
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Body — the only part that scrolls, and only when it has to. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
        {status.hasIntegration && !status.connected && (
          <div className="flex items-center justify-between gap-2 text-xs bg-amber-500/10 border border-amber-500/25 rounded-xl px-3.5 py-2">
            <span className="text-slate-200">You have a saved connection that is switched off.</span>
            <Button
              size="sm"
              disabled={busy !== null && busy !== 'reconnect'}
              loading={busy === 'reconnect'}
              onClick={() => run('reconnect', () => reconnectTelnyx(), 'Telnyx reconnected.')}
            >
              Reconnect
            </Button>
          </div>
        )}

        {tab === 'connect' ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
              <div className="md:col-span-2">
                <Field label="API key" required={!status.connected} hint={!usingStored && <PortalPath path={API_KEY_PATH} />}>
                  {usingStored ? (
                    <div className="space-y-1.5">
                      <div className="h-11 flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs">
                        {lookup.loading ? (
                          <RefreshCw className="w-3.5 h-3.5 text-slate-400 animate-spin shrink-0" />
                        ) : lookup.error ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                        )}
                        {/* That a key is stored and works is the whole message. Its characters are not, even masked. */}
                        <span className="text-white truncate">
                          {lookup.loading
                            ? 'Checking saved key…'
                            : lookup.error
                              ? 'Saved key is not working'
                              : `Saved and verified · ${lookup.numbers?.length ?? 0} numbers`}
                        </span>
                        {lookup.error && (
                          <Button variant="link" onClick={() => void lookup.verify()} icon={<RefreshCw />}>
                            Retry
                          </Button>
                        )}
                        <Button
                          variant="link"
                          className="ml-auto"
                          onClick={() => {
                            setReplacingKey(true);
                            lookup.reset();
                          }}
                          icon={<Pencil />}
                        >
                          Replace
                        </Button>
                      </div>
                      {lookup.error && <p className="text-2xs text-rose-400">{lookup.error}</p>}
                    </div>
                  ) : (
                    <ApiKeyInput
                      value={apiKey}
                      onChange={(v) => {
                        setApiKey(v);
                        if (lookup.error) lookup.reset();
                      }}
                      onVerify={() => void lookup.verify(apiKey)}
                      verifying={lookup.loading}
                      verified={keyVerified}
                      error={lookup.error}
                      count={lookup.numbers?.length}
                      autoFocus={replacingKey}
                      trailing={
                        status.connected && (
                          <Button
                            variant="ghost"
                            className="h-11!"
                            onClick={() => {
                              setReplacingKey(false);
                              setApiKey('');
                              void lookup.verify();
                            }}
                          >
                            Cancel
                          </Button>
                        )
                      }
                    />
                  )}
                </Field>
              </div>

              <Field label="From number" required>
                {keyVerified && lookup.numbers ? (
                  <FromNumberSelect numbers={lookup.numbers} value={fromNumber} onChange={setFromNumber} />
                ) : (
                  <NumberLocked />
                )}
              </Field>

              {/* Named, because an org with three of these cannot tell them apart by a masked key. */}
              <Field label="Account name">
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional, e.g. Austin office" className={input} />
              </Field>

              <div className="md:col-span-2">
                <Field label="Public key" required={!status.hasPublicKey} hint={<PublicKeyHint />}>
                  <input
                    value={publicKey}
                    onChange={(e) => setPublicKey(e.target.value)}
                    placeholder={status.hasPublicKey ? 'Saved. Paste a new one to replace it' : 'e.g. AbCd…='}
                    className={`${input} font-mono`}
                  />
                </Field>
              </div>
            </div>

            {/* The Call Control Application and Messaging Profile are found from the key (and repaired if they go stale),
                so they are an override folded away, not a question. */}
            <div>
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                className="text-xs text-slate-400 hover:text-slate-200 font-semibold flex items-center gap-1 cursor-pointer"
              >
                {advanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Advanced settings
              </button>

              {advanced && (
                <div className="mt-3 space-y-3">
                  <p className="text-2xs text-slate-400">
                    We detect these from your API key. Fill them in only if calls must use a specific connection. Leave blank to auto-detect.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Field label="Voice connection ID">
                      <input
                        value={connectionId}
                        onChange={(e) => setConnectionId(e.target.value)}
                        placeholder={status.connectionId || 'Auto-detect'}
                        className={`${input} font-mono`}
                      />
                    </Field>
                    <Field label="Messaging profile ID">
                      <input
                        value={messagingProfileId}
                        onChange={(e) => setMessagingProfileId(e.target.value)}
                        placeholder={status.messagingProfileId || 'Auto-detect (none means texts are off)'}
                        className={`${input} font-mono`}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>

            {/* The other accounts on file, and the way to put another one there. */}
            {status.connected && (
              <div className="space-y-3 pt-3 border-t border-slate-800">
                <TelnyxAccounts accounts={accounts} onChange={refresh} />

                {adding ? (
                  <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 space-y-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-white">Add another Telnyx account</p>
                        <p className="text-2xs text-slate-400 mt-0.5">It becomes the active account right away. Your current one is kept.</p>
                      </div>
                      <IconButton onClick={() => setAdding(false)} aria-label="Close" icon={<X />} />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
                      <div className="md:col-span-2">
                        <Field label="API key" required hint={<PortalPath path={API_KEY_PATH} />}>
                          <ApiKeyInput
                            value={newApiKey}
                            onChange={(v) => {
                              setNewApiKey(v);
                              if (newLookup.error) newLookup.reset();
                            }}
                            onVerify={() => void newLookup.verify(newApiKey)}
                            verifying={newLookup.loading}
                            verified={newKeyVerified}
                            error={newLookup.error}
                            count={newLookup.numbers?.length}
                          />
                        </Field>
                      </div>
                      <Field label="From number" required>
                        {newKeyVerified && newLookup.numbers ? (
                          <FromNumberSelect numbers={newLookup.numbers} value={newFrom} onChange={setNewFrom} />
                        ) : (
                          <NumberLocked />
                        )}
                      </Field>
                      <Field label="Account name">
                        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Dallas office" className={input} />
                      </Field>
                      <div className="md:col-span-2">
                        <Field label="Public key" required hint={<PublicKeyHint />}>
                          <input
                            value={newPublicKey}
                            onChange={(e) => setNewPublicKey(e.target.value)}
                            placeholder="e.g. AbCd…="
                            className={`${input} font-mono`}
                          />
                        </Field>
                      </div>
                    </div>

                    <Button
                      disabled={(busy !== null && busy !== 'add') || !newKeyVerified || !newFrom.trim() || !newPublicKey.trim()}
                      loading={busy === 'add'}
                      icon={<Plus />}
                      onClick={() =>
                        run('add', () =>
                          addTelnyxAccount({
                            label: newLabel.trim(),
                            apiKey: newApiKey.trim(),
                            publicKey: newPublicKey.trim(),
                            fromNumber: newFrom.trim(),
                          }).then((r) => {
                            setNewLabel('');
                            setNewApiKey('');
                            setNewPublicKey('');
                            setNewFrom('');
                            newLookup.reset();
                            setAdding(false);
                            toast.success('Telnyx account added.');
                            return r;
                          }),
                        )
                      }
                    >
                      Add and switch to it
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setAdding(true)} icon={<Plus />}>
                    Add another Telnyx account
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Option A: attach one the account already has */}
            <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
              <div>
                <p className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-cyan-400" /> Use one you already have
                </p>
                <p className="text-2xs text-slate-400 mt-1">
                  {assistants === null
                    ? 'Loading your assistants…'
                    : assistants.length
                      ? `${assistants.length} found on this Telnyx account.`
                      : 'No assistants on this account yet.'}
                </p>
              </div>

              {pasteId ? (
                <input
                  value={assistantId}
                  onChange={(e) => setAssistantId(e.target.value)}
                  placeholder="assistant-…"
                  className={`${input} font-mono`}
                />
              ) : assistants === null ? (
                <div className="h-11 rounded-xl border border-slate-800 bg-slate-950 px-3.5 flex items-center gap-2 text-xs text-slate-500">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading…
                </div>
              ) : (
                <div className={busy === 'attach' ? 'pointer-events-none opacity-60' : ''}>
                  <RichSelect
                    options={assistantOptions}
                    value={assistantPick}
                    onChange={(id) => void pickAssistant(id)}
                    placeholder="Select an assistant to attach it"
                    icon={<Bot />}
                    emptyText="No assistants yet. Create one instead."
                  />
                </div>
              )}
              {assistantsError && !pasteId && <p className="text-2xs text-rose-400">{assistantsError}</p>}

              {/* What selecting did, said right under the list. */}
              {!pasteId && assistants !== null && (
                <p className="text-2xs flex items-center gap-1.5">
                  {busy === 'attach' ? (
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <RefreshCw className="w-3 h-3 animate-spin" /> Attaching…
                    </span>
                  ) : status.hasAssistant ? (
                    <span className="text-green-400 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3" /> {attachedName || 'An assistant'} is attached. Pick another to switch.
                    </span>
                  ) : (
                    <span className="text-slate-500">Selecting one attaches it straight away.</span>
                  )}
                </p>
              )}

              <div className="flex items-center gap-3 mt-auto">
                {pasteId && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={(busy !== null && busy !== 'attach') || !attachTarget || attachTarget === status.assistantId}
                    loading={busy === 'attach'}
                    icon={<Link2 />}
                    onClick={() => run('attach', () => attachAssistant(attachTarget), 'AI assistant attached.')}
                  >
                    {attachTarget && attachTarget === status.assistantId ? 'Attached' : 'Attach'}
                  </Button>
                )}
                <Button variant="link" onClick={() => setPasteId((v) => !v)}>
                  {pasteId ? 'Choose from list' : 'Paste an ID instead'}
                </Button>
              </div>
            </div>

            {/* Option B: auto-create */}
            <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
              <div>
                <p className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Create a new one
                  <span className="text-2xs font-semibold px-1.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                    Recommended
                  </span>
                </p>
                <p className="text-2xs text-slate-400 mt-1">Ready to use for real-estate leads. Just give it a name.</p>
              </div>
              <input
                value={assistantName}
                onChange={(e) => setAssistantName(e.target.value)}
                placeholder="e.g. Austin Home Advisors"
                className={input}
              />
              <Button
                size="sm"
                disabled={(busy !== null && busy !== 'create') || !assistantName.trim()}
                loading={busy === 'create'}
                icon={<Sparkles />}
                className="self-start mt-auto"
                onClick={() =>
                  run('create', () => createAssistant(assistantName).then(() => setActiveView('ai_settings')), 'AI assistant created.')
                }
              >
                Create assistant
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Footer — the main action is always in view, never scrolled away. */}
      <div className="shrink-0 px-5 py-3 border-t border-slate-800 bg-slate-900 flex flex-wrap items-center gap-3">
        {tab === 'connect' ? (
          <>
            {status.connected && (
              <Button
                variant="danger-soft"
                size="sm"
                disabled={busy !== null && busy !== 'disconnect'}
                loading={busy === 'disconnect'}
                onClick={() => run('disconnect', () => disconnectTelnyx(), 'Telnyx disconnected.')}
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            )}
            <p className="text-2xs text-slate-400 min-w-0 flex-1 truncate">
              {missing.length > 0 ? `Still needed: ${missing.join(', ')}` : 'All set. Save to apply.'}
            </p>
            <Button
              disabled={(busy !== null && busy !== 'save') || missing.length > 0}
              loading={busy === 'save'}
              icon={<KeyRound />}
              onClick={save}
            >
              {status.connected ? 'Save changes' : 'Connect Telnyx'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-2xs text-slate-400 min-w-0 flex-1">
              {status.hasAssistant ? 'Prompt, voice and tone are edited in AI Agent settings.' : 'Attach or create an assistant so the agent can take calls.'}
            </p>
            {onClose && (
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

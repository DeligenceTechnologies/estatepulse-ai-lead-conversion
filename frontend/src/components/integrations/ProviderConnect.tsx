import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, AlertTriangle, Sparkles, Link2, CheckCircle2, Pencil, ChevronDown, ChevronRight, Plus, X, ExternalLink, Lock } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  TelnyxStatus,
  TelnyxCredentials,
  TelnyxAccount,
  saveTelnyxCredentials,
  addTelnyxAccount,
  listTelnyxAccounts,
  createAssistant,
  attachAssistant,
  reconnectTelnyx,
  disconnectTelnyx,
} from '../../utils/assistantApi';
import { TelnyxAccounts } from './TelnyxAccounts';
import { useApp } from '../../context/AppContext';
import { FromNumberSelect } from './FromNumberSelect';
import { IconButton, Button } from '../common/Button';

const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500';

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
    {hint && <p className="text-2xs text-slate-400 mt-1.5">{hint}</p>}
  </div>
);

/** A numbered step heading; the number turns into a tick once the step is done. */
const Step: React.FC<{ n: number; title: string; done?: boolean; aside?: React.ReactNode }> = ({ n, title, done, aside }) => (
  <div className="flex items-center gap-2.5">
    <span
      className={`w-6 h-6 rounded-full text-2xs font-bold flex items-center justify-center shrink-0 border ${
        done ? 'bg-green-500/15 text-green-300 border-green-500/30' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
      }`}
    >
      {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : n}
    </span>
    <span className="text-sm font-bold text-white">{title}</span>
    {aside && <div className="ml-auto">{aside}</div>}
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
export const ProviderConnect: React.FC<{ status: TelnyxStatus; onChange: () => void }> = ({ status, onChange }) => {
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
  const [assistantId, setAssistantId] = useState('');
  const [assistantName, setAssistantName] = useState('');
  const { setActiveView } = useApp();
  const [busy, setBusy] = useState<string | null>(null);

  // The shelf of saved accounts, and the separate form for putting a new one on it.
  const [accounts, setAccounts] = useState<TelnyxAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newPublicKey, setNewPublicKey] = useState('');
  const [newFrom, setNewFrom] = useState('');

  const loadAccounts = useCallback(() => {
    listTelnyxAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  useEffect(loadAccounts, [loadAccounts]);

  // Every mutation moves both the status the parent holds and the shelf here.
  const refresh = () => {
    onChange();
    loadAccounts();
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

  const missing = [
    !apiKey && !status.connected && 'API key',
    !status.hasPublicKey && !publicKey.trim() && 'Public key',
    !fromNumber.trim() && 'From number',
  ].filter(Boolean) as string[];

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-5 shadow-xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center shrink-0">
            <KeyRound className="w-4 h-4 text-emerald-400" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white">
              {status.connected ? status.label || 'Your Telnyx connection' : 'Connect your Telnyx account'}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {status.connected
                ? 'Change the number you call from, or swap the key.'
                : 'Your AI agent calls and texts through your own Telnyx account. Takes about 2 minutes.'}
            </p>
          </div>
        </div>
        <a
          href="https://portal.telnyx.com"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 shrink-0"
        >
          Open Telnyx portal <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      {status.hasIntegration && !status.connected && (
        <div className="flex items-center justify-between gap-2 text-xs bg-amber-500/10 border border-amber-500/25 rounded-xl px-3.5 py-2.5">
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

      {/* Step 1 — credentials */}
      <section className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 space-y-4">
        <Step
          n={1}
          title="Your Telnyx keys"
          done={status.connected}
          aside={
            status.connected && (
              <Button
                variant="danger-soft"
                size="sm"
                disabled={busy !== null && busy !== 'disconnect'}
                loading={busy === 'disconnect'}
                onClick={() => run('disconnect', () => disconnectTelnyx(), 'Telnyx disconnected.')}
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            )
          }
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Named, because an org with three of these cannot tell them apart by a masked key. */}
          <Field label="Account name" hint="Optional. Helps if you have more than one.">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Austin office" className={input} />
          </Field>

          <Field label="API key" required={!status.connected} hint={!status.connected && 'Telnyx → Keys & Credentials → API Keys'}>
            {status.connected && !replacingKey ? (
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                {/* That a key is stored and works is the whole message. Its characters are not, even masked. */}
                <span className="text-white truncate">Saved and working</span>
                <Button variant="link" className="ml-auto" onClick={() => setReplacingKey(true)} icon={<Pencil />}>
                  Replace
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={apiKey}
                  autoFocus={replacingKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="KEY0123…"
                  className={`${input} font-mono`}
                />
                {status.connected && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReplacingKey(false);
                      setApiKey('');
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </Field>

          <Field label="Public key" required={!status.hasPublicKey} hint="Telnyx → Keys & Credentials → Public Key">
            <input
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder={status.hasPublicKey ? 'Saved. Paste a new one to replace it' : 'e.g. AbCd…='}
              className={`${input} font-mono`}
            />
          </Field>

          <Field label="From number" required hint="The number your AI calls and texts from.">
            <FromNumberSelect
              apiKey={apiKey}
              useStored={status.connected}
              storedKeyId={status.accountId}
              value={fromNumber}
              onChange={setFromNumber}
            />
          </Field>
        </div>

        {status.connected && (
          <div className="flex flex-wrap items-center gap-2 text-2xs font-semibold">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/25">
              <CheckCircle2 className="w-3 h-3" /> Calls ready
            </span>
            {status.hasMessaging ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/25">
                <CheckCircle2 className="w-3 h-3" /> Texts ready
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/25"
                title="Assign your number to a Telnyx Messaging Profile to enable texting."
              >
                <AlertTriangle className="w-3 h-3" /> Texts off: add your number to a Messaging Profile in Telnyx
              </span>
            )}
          </div>
        )}

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

        <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-slate-800">
          <Button
            disabled={(busy !== null && busy !== 'save') || missing.length > 0}
            loading={busy === 'save'}
            icon={<KeyRound />}
            onClick={() =>
              run('save', () => {
                const payload: TelnyxCredentials = { fromNumber, label };
                if (apiKey) payload.apiKey = apiKey;
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
                  return r;
                });
              })
            }
          >
            {status.connected ? 'Save changes' : 'Connect Telnyx'}
          </Button>
          {missing.length > 0 && <p className="text-2xs text-slate-400">Still needed: {missing.join(', ')}</p>}
        </div>
      </section>

      {/* The other accounts on file, and the way to put another one there. */}
      {status.connected && (
        <div className="space-y-3">
          <TelnyxAccounts accounts={accounts} onChange={refresh} />

          {adding ? (
            <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-white">Add another Telnyx account</p>
                <IconButton onClick={() => setAdding(false)} aria-label="Close" icon={<X />} />
              </div>
              <p className="text-2xs text-slate-400">It becomes the active account right away. Your current one is kept.</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Account name">
                  <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Dallas office" className={input} />
                </Field>
                <Field label="API key" required>
                  <input
                    type="password"
                    value={newApiKey}
                    onChange={(e) => setNewApiKey(e.target.value)}
                    placeholder="KEY0123…"
                    className={`${input} font-mono`}
                  />
                </Field>
                <Field label="Public key" required>
                  <input
                    value={newPublicKey}
                    onChange={(e) => setNewPublicKey(e.target.value)}
                    placeholder="e.g. AbCd…="
                    className={`${input} font-mono`}
                  />
                </Field>
                <Field label="From number" required>
                  <FromNumberSelect apiKey={newApiKey} useStored={false} value={newFrom} onChange={setNewFrom} compact />
                </Field>
              </div>

              <Button
                size="sm"
                disabled={(busy !== null && busy !== 'add') || !newApiKey.trim() || !newFrom.trim() || !newPublicKey.trim()}
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

      {/* Step 2 — assistant. Folded to one line until step 1 is done, so the first visit is one short form. */}
      <section className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 space-y-4">
        <Step
          n={2}
          title="AI voice assistant"
          done={status.hasAssistant}
          aside={
            !status.connected && (
              <span className="inline-flex items-center gap-1.5 text-2xs text-slate-400">
                <Lock className="w-3 h-3" /> Finish step 1 first
              </span>
            )
          }
        />

        {status.connected && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Option A: auto-create */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
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
                className="self-start"
                onClick={() =>
                  run('create', () => createAssistant(assistantName).then(() => setActiveView('ai_settings')), 'AI assistant created.')
                }
              >
                Create assistant
              </Button>
            </div>

            {/* Option B: attach existing */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
              <div>
                <p className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-cyan-400" /> Use one you already have
                </p>
                <p className="text-2xs text-slate-400 mt-1">Paste its ID from Telnyx.</p>
              </div>
              <input
                value={assistantId}
                onChange={(e) => setAssistantId(e.target.value)}
                placeholder="assistant-…"
                className={`${input} font-mono`}
              />
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={(busy !== null && busy !== 'attach') || !assistantId}
                loading={busy === 'attach'}
                icon={<Link2 />}
                onClick={() => run('attach', () => attachAssistant(assistantId.trim()), 'AI assistant attached.')}
              >
                Attach
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

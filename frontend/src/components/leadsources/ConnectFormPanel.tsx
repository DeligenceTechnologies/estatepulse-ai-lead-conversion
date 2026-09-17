import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Link2,
  Loader2,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  ApiError,
  providersApi,
  type ConnectFormResult,
  type ProviderConnection,
  type ProviderForm,
  type ProviderInfo,
} from '../../api/client';
import { CopyField } from './CopyField';
import { CredentialField } from './CredentialField';
import { FormPicker } from './FormPicker';

/**
 * Connect a form through the provider's API.
 *
 * Inline rather than a modal on purpose: every file in components/modals is
 * bound to the demo store in AppContext, and this flow talks to the live API.
 * Keeping it here preserves the one-directional rule the codebase is built on.
 */

type Step =
  | { k: 'credential' }
  | { k: 'forms' }
  | { k: 'installing' }
  | { k: 'done'; result: ConnectFormResult };

interface PanelError {
  title: string;
  body: string;
  hint?: string;
  tone: 'rose' | 'amber';
}

/**
 * Copy written for the person reading it, who did not write our backend.
 *
 * The distinction that matters most: "the provider is down" must never read as
 * "your server is broken" — that sends someone restarting the wrong thing.
 */
function mapError(e: unknown): PanelError {
  const err = e instanceof ApiError ? e : null;
  const code = err?.code ?? '';

  if (code === 'PROVIDER_INVALID_CREDENTIAL' || code === 'CREDENTIAL_REQUIRED') {
    return {
      tone: 'rose',
      title: "That key wasn't accepted",
      body: 'We sent it to the provider and got back "unauthorized". It may have been copied short, or deleted since.',
      hint: 'Create a fresh key and paste the new value — we cleared the field, because re-sending a rejected key never helps.',
    };
  }
  if (code === 'PROVIDER_RATE_LIMITED') {
    return {
      tone: 'amber',
      title: 'The provider is rate-limiting us',
      body: 'Too many requests in a short window. Nothing was created and nothing is half-done.',
      hint: 'Wait about a minute and try again.',
    };
  }
  if (code === 'PROVIDER_UNAVAILABLE') {
    return {
      tone: 'amber',
      title: "Can't reach the provider",
      body: 'Our API is fine — theirs is not responding. Your key is saved.',
      hint: 'Try again shortly. If a lead source was created, use Re-sync on it rather than connecting again.',
    };
  }
  if (code === 'FORM_ALREADY_CONNECTED') {
    return {
      tone: 'amber',
      title: 'That form is already connected',
      body: 'It already feeds an existing lead source. Connecting it twice would deliver every submission to us twice.',
    };
  }
  if (code === 'PUBLIC_BASE_URL_NOT_PUBLIC' || code === 'PUBLIC_BASE_URL_INVALID') {
    return {
      tone: 'rose',
      title: 'This server is not reachable from the internet',
      body: err?.message ?? '',
      hint: 'The provider has to be able to call us. Locally that means a tunnel (ngrok) with PUBLIC_API_BASE_URL pointed at it.',
    };
  }
  if (code === 'PROVIDER_FORBIDDEN') {
    return {
      tone: 'rose',
      title: 'That key is valid but not allowed to do this',
      body: err?.message ?? '',
      hint: 'Check the key belongs to an account that owns the form.',
    };
  }
  if (code === 'CREDENTIAL_IN_USE') {
    return {
      tone: 'amber',
      title: 'Forms are still using this key',
      body: err?.message ?? '',
      hint: 'Press again to remove it anyway. Those forms keep delivering leads — we just lose the ability to repair or remove their webhooks for you.',
    };
  }
  return {
    tone: 'rose',
    title: 'Something went wrong',
    body: err?.message ?? String(e),
  };
}

const ErrorBlock: React.FC<{ e: PanelError }> = ({ e }) => (
  <div
    className={`rounded-xl p-3 flex items-start gap-2 border ${
      e.tone === 'rose' ? 'bg-rose-500/10 border-rose-500/30' : 'bg-amber-500/10 border-amber-500/30'
    }`}
  >
    <AlertTriangle
      className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${e.tone === 'rose' ? 'text-rose-400' : 'text-amber-400'}`}
    />
    <div className={`text-[11px] leading-relaxed ${e.tone === 'rose' ? 'text-rose-200' : 'text-amber-200'}`}>
      <div className={`font-semibold ${e.tone === 'rose' ? 'text-rose-100' : 'text-amber-100'}`}>{e.title}</div>
      {e.body}
      {e.hint && <div className="mt-1 opacity-80">{e.hint}</div>}
    </div>
  </div>
);

export const ConnectFormPanel: React.FC<{
  onClose: () => void;
  onConnected: (leadSourceId: string) => void;
  onOpenSource: (leadSourceId: string) => void;
  onSetUpManually: () => void;
}> = ({ onClose, onConnected, onOpenSource, onSetUpManually }) => {
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const [step, setStep] = useState<Step>({ k: 'credential' });
  const [error, setError] = useState<PanelError | null>(null);

  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const [confirmForget, setConfirmForget] = useState(false);

  const [forms, setForms] = useState<ProviderForm[] | null>(null);
  const [loadingForms, setLoadingForms] = useState(false);
  const [selectedForm, setSelectedForm] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState('');

  // The key must not outlive the component in React state.
  useEffect(() => () => setApiKey(''), []);

  const loadForms = useCallback(async (connectionId: string) => {
    setLoadingForms(true);
    try {
      const page = await providersApi.forms(connectionId);
      setForms(page.items);
      setError(null);
    } catch (e) {
      setForms([]);
      setError(mapError(e));
    } finally {
      setLoadingForms(false);
    }
  }, []);

  // An existing connection skips straight to the picker: the provider showed
  // the key once, so asking for it again would be asking for something gone.
  useEffect(() => {
    void (async () => {
      try {
        const [providers, connections] = await Promise.all([
          providersApi.list(),
          providersApi.connections(),
        ]);
        setProvider(providers[0] ?? null);
        const live = connections.find((c) => c.status !== 'REVOKED');
        if (live) {
          setConnection(live);
          setStep({ k: 'forms' });
          void loadForms(live.id);
        }
      } catch (e) {
        setError(mapError(e));
      }
    })();
  }, [loadForms]);

  const submitKey = async () => {
    if (!apiKey || busy) return;
    setBusy(true);
    try {
      const conn = await providersApi.connect(provider?.code ?? 'TALLY', apiKey);
      setConnection(conn);
      setStep({ k: 'forms' });
      setError(null);
      void loadForms(conn.id);
    } catch (e) {
      setError(mapError(e));
    } finally {
      // Cleared even on failure: a rejected key is wrong or revoked, and
      // re-submitting the same string is never the fix.
      setApiKey('');
      setBusy(false);
    }
  };

  const submitForm = async () => {
    if (!connection || !selectedForm || busy) return;
    setBusy(true);
    setStep({ k: 'installing' });
    try {
      const result = await providersApi.connectForm(connection.id, selectedForm, sourceName.trim() || undefined);
      setStep({ k: 'done', result });
      setError(null);
      onConnected(result.id);
    } catch (e) {
      setStep({ k: 'forms' });
      setError(mapError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Removes the stored key so a different one can be pasted.
   *
   * Two presses when forms are connected, because the first attempt is refused
   * on purpose: those forms go on delivering leads afterwards, and all that is
   * lost is our ability to repair or remove their webhooks. That is worth
   * reading once before it happens, and worth doing when the answer is "this
   * key is wrong" — which is the only reason anyone opens this.
   */
  const forgetAccount = async () => {
    if (!connection || busy) return;
    setBusy(true);
    try {
      await providersApi.disconnectAccount(connection.id, confirmForget);
      setConnection(null);
      setForms(null);
      setConfirmForget(false);
      setApiKey('');
      setError(null);
      setStep({ k: 'credential' });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CREDENTIAL_IN_USE') setConfirmForget(true);
      setError(mapError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-emerald-500/40 rounded-2xl p-5 space-y-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">
            {step.k === 'done' ? 'Connected' : 'Connect a form'}
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {step.k === 'done'
              ? 'Nothing to paste anywhere — the webhook is already on your form.'
              : `We install the webhook on your ${provider?.displayName ?? 'provider'} form for you.`}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {error && <ErrorBlock e={error} />}

      {/* --- 1. credential ---------------------------------------------- */}
      {step.k === 'credential' && (
        <div className="space-y-3">
          <CredentialField
            label={provider?.capabilities.credentialLabel ?? 'API key'}
            value={apiKey}
            onChange={setApiKey}
            onSubmit={submitKey}
            disabled={busy}
          />
          <div className="text-[11px] text-slate-500">{provider?.capabilities.credentialHint}</div>

          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-[11px] text-amber-200 leading-relaxed flex gap-2">
            <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              This key can read and change everything in that account — all forms and all
              submissions, not just the one you pick. We use it to list your forms and install one
              webhook. It is encrypted at rest and never sent back to this browser. Disconnect here,
              or delete the key with your provider, to revoke it.
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <button
              onClick={onSetUpManually}
              className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
            >
              Rather not share a key? Set it up manually →
            </button>
            <button
              onClick={submitKey}
              disabled={busy || !apiKey}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-emerald-950 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Connect
            </button>
          </div>
        </div>
      )}

      {/* --- 2. pick a form --------------------------------------------- */}
      {step.k === 'forms' && connection && (
        <div className="space-y-3">
          <div className="bg-slate-950 border border-emerald-500/30 rounded-xl p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Link2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="text-xs text-slate-200 font-medium truncate">
                {provider?.displayName ?? connection.provider} · {connection.accountEmail ?? connection.label ?? 'connected'}
              </span>
              <span className="text-[10px] font-mono text-slate-500 shrink-0">
                {connection.credentialPreview}
              </span>
            </div>
            <button
              onClick={forgetAccount}
              disabled={busy}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer shrink-0 disabled:opacity-50 ${
                confirmForget
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              {confirmForget ? 'Remove it anyway' : 'Use a different key'}
            </button>
          </div>

          <FormPicker
            forms={forms}
            loading={loadingForms}
            selected={selectedForm}
            onSelect={(id) => {
              setSelectedForm(id);
              const f = forms?.find((x) => x.externalFormId === id);
              if (f && !sourceName.trim()) setSourceName(f.name);
            }}
            onRefresh={() => void loadForms(connection.id)}
            onOpenSource={onOpenSource}
          />

          {selectedForm && (
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400 font-medium">Name this lead source</div>
              <input
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={submitForm}
              disabled={!selectedForm || busy}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-emerald-950 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Connect this form
            </button>
          </div>
        </div>
      )}

      {/* --- 3. installing ---------------------------------------------- */}
      {step.k === 'installing' && (
        <div className="flex items-center gap-2 text-xs text-slate-300 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
          Installing the webhook and reading your form…
        </div>
      )}

      {/* --- 4. done ------------------------------------------------------ */}
      {step.k === 'done' && <DoneCard result={step.result} onClose={onClose} />}
    </div>
  );
};

/**
 * The success state, and deliberately NOT the old "paste these into Tally"
 * card: the signing secret was installed by us, so the customer never needs to
 * see it. That removes the whole "shown once, don't lose it" anxiety here.
 */
const DoneCard: React.FC<{ result: ConnectFormResult; onClose: () => void }> = ({ result, onClose }) => {
  const p = result.prebuild;
  const needsReview = p?.needsReview.length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
        <div className="text-xs text-slate-200">
          <div className="font-semibold text-white">"{result.name}" is connected</div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            {result.externalFormName ?? result.connection.externalFormId}
          </div>
        </div>
      </div>

      <div className="space-y-1.5 text-[11px]">
        <div className="text-emerald-300 flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3" /> Webhook installed on your form — nothing to paste
        </div>
        <div className="text-emerald-300 flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3" /> Signing secret generated and registered on both sides
        </div>
        {p ? (
          <div className={needsReview ? 'text-amber-300 flex items-center gap-1.5' : 'text-emerald-300 flex items-center gap-1.5'}>
            <SlidersHorizontal className="w-3 h-3" />
            {p.fields} questions read · {p.mapped} mapped automatically
            {p.unmapped > 0 && ` · ${p.unmapped} kept as extra`}
          </div>
        ) : (
          <div className="text-slate-400 flex items-center gap-1.5">
            <SlidersHorizontal className="w-3 h-3" />
            Fields will be mapped when the first submission arrives.
          </div>
        )}
      </div>

      {needsReview > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-[11px] text-amber-200 leading-relaxed flex gap-2">
          <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            We deliberately did not map <strong>{p!.needsReview.join(', ').replace(/_/g, ' ')}</strong>.
            Consent decides whether we may text or call someone, so it is never guessed from a form's
            wording — set it yourself before enabling outreach. Everything else is already live.
          </span>
        </div>
      )}

      {result.webhookUrl && (
        <details className="group">
          <summary className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-300 transition-colors">
            Webhook details (for troubleshooting)
          </summary>
          <div className="mt-2">
            <CopyField label="Webhook URL" value={result.webhookUrl} />
          </div>
        </details>
      )}

      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  );
};

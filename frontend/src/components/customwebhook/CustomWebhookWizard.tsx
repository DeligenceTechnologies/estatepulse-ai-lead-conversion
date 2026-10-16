import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Play, Radio, SlidersHorizontal, Webhook } from 'lucide-react';
import { useLiveEvents } from '../../lib/liveEvents';
import {
  activateCustomWebhook,
  createCustomWebhook,
  customWebhookSample,
  saveCustomWebhookMapping,
  testCustomWebhook,
  type CustomAuth,
  type CustomWebhookSample,
  type LeadPreview,
} from '../../utils/customWebhookApi';
import {
  AUTH_PRESETS,
  FIELD_LABEL,
  TARGET_CHOICES,
  curlExample,
  draftFromFields,
  draftProblems,
  fieldsFromDraft,
  type AuthPreset,
  type Draft,
  type DraftRow,
  type TargetChoice,
} from '../../utils/customWebhookMapping';
import { CopyField } from '../leadsources/CopyField';
import { SheetError, SheetModal, errorDetails, errorText } from '../sheets/SheetModal';

/**
 * Add a webhook: name and how the sender proves itself -> URL and secret
 * (shown once) -> wait for the first payload -> map its fields to lead fields,
 * watching the lead it would make -> save and switch on. Opened again on an
 * existing webhook, it starts at the mapper (or keeps waiting if nothing has
 * arrived yet).
 *
 * A payload with a known form's shape (Tally, Typeform) arrives already read as
 * that form: its questions by their stable keys, options resolved, the
 * provider's own heuristics as the prefill. Anything else is JSON paths.
 */

const input = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500';
const select = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500/60';
const primary = 'px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 text-on-accent hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center justify-center gap-1.5';
const secondary = 'px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center justify-center gap-1.5';

type Step = 'setup' | 'waiting' | 'map' | 'done';

interface AuthForm {
  preset: AuthPreset['id'];
  headerName: string;
  algorithm: 'sha256' | 'sha1';
  encoding: 'hex' | 'base64';
  prefix: string;
  username: string;
}

function toAuth(f: AuthForm): CustomAuth {
  const preset = AUTH_PRESETS.find((p) => p.id === f.preset);
  if (preset?.auth) return preset.auth;
  switch (f.preset) {
    case 'none':
      return { mode: 'none' };
    case 'basic':
      return { mode: 'basic', username: f.username.trim() };
    case 'hmac':
      return { mode: 'hmac', headerName: f.headerName.trim(), algorithm: f.algorithm, encoding: f.encoding, ...(f.prefix.trim() ? { prefix: f.prefix.trim() } : {}) };
    default:
      return { mode: 'header_secret', headerName: f.headerName.trim() };
  }
}

const FORMAT_NAME: Record<string, string> = { TALLY: 'Tally', TYPEFORM: 'Typeform' };

/** What the worker would make of the last payload, as a short card. */
const Preview: React.FC<{ preview: LeadPreview | null; loading: boolean; error: string | null; from: 'draft' | 'saved' }> = ({ preview, loading, error, from }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2 min-h-[8rem]">
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs font-bold text-white">Lead this payload would create</div>
      <span className="text-2xs text-slate-500">{from === 'saved' ? 'saved mapping' : 'draft'}</span>
    </div>
    {loading && (
      <div className="text-2xs text-slate-400 flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Trying the mapping…
      </div>
    )}
    {error && <div className="text-2xs text-rose-300">{error}</div>}
    {!loading && !error && !preview && <div className="text-2xs text-slate-500">Map a phone or an email and the preview appears here.</div>}
    {preview && (
      <>
        <div className="flex items-center gap-1.5 flex-wrap text-2xs">
          {preview.wouldCreate ? (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold">
              creates a lead · {preview.status}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 font-semibold">
              no lead: neither phone nor email
            </span>
          )}
          {preview.reviewReasons.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold">needs review</span>
          )}
        </div>
        <div className="space-y-0.5">
          {Object.entries(preview.values).map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2 text-xs">
              <span className="text-slate-400 min-w-[40%] shrink-0 truncate">{FIELD_LABEL[k] ?? k}</span>
              <span className="text-slate-100 font-medium break-words">{String(v)}</span>
            </div>
          ))}
          {Object.entries(preview.customFields).map(([k, v]) => (
            <div key={`c:${k}`} className="flex items-baseline gap-2 text-xs">
              <span className="text-slate-500 min-w-[40%] shrink-0 truncate" title="Extra field">
                {k} <span className="text-2xs">(extra)</span>
              </span>
              <span className="text-slate-300 break-words">{v}</span>
            </div>
          ))}
        </div>
        {[...preview.reviewReasons, ...preview.warnings.filter((w) => !preview.reviewReasons.includes(w))].map((w, i) => (
          <div key={i} className="text-2xs text-amber-300/90 flex items-start gap-1">
            <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
            {w}
          </div>
        ))}
      </>
    )}
  </div>
);

export const CustomWebhookWizard: React.FC<{
  /** Null: create a new webhook. Otherwise open this one's mapper. */
  sourceId: string | null;
  onClose: () => void;
  /** Something changed on the server: the caller refreshes its list. */
  onChanged: () => void;
}> = ({ sourceId, onClose, onChanged }) => {
  const [step, setStep] = useState<Step>(sourceId ? 'map' : 'setup');
  const [id, setId] = useState<string | null>(sourceId);
  const [name, setName] = useState('');
  const [auth, setAuth] = useState<AuthForm>({ preset: 'header', headerName: 'X-Webhook-Secret', algorithm: 'sha256', encoding: 'hex', prefix: '', username: '' });
  const [deliveryIdHeader, setDeliveryIdHeader] = useState('');
  /** Shown once, right after creation. */
  const [secret, setSecret] = useState<string | null>(null);
  const [sample, setSample] = useState<CustomWebhookSample | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<LeadPreview | null>(null);
  const [previewFrom, setPreviewFrom] = useState<'draft' | 'saved'>('draft');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'create' | 'load' | 'save' | 'activate'>(sourceId ? 'load' : null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const [released, setReleased] = useState(0);

  const load = useCallback(async (webhookId: string, seedDraft: boolean) => {
    const s = await customWebhookSample(webhookId);
    setSample(s);
    if (seedDraft) setDraft(draftFromFields(s.custom.fields.length ? s.custom.fields : s.suggested));
    setStep(s.delivery ? 'map' : 'waiting');
    return s;
  }, []);

  // Opened on an existing webhook.
  useEffect(() => {
    if (!sourceId) return;
    setBusy('load');
    load(sourceId, true)
      .catch((e) => setError({ message: errorText(e), details: [] }))
      .finally(() => setBusy(null));
  }, [sourceId, load]);

  // Waiting for the first payload: the live stream says when one lands, and a
  // slow poll covers a stream that is not connected.
  const waiting = step === 'waiting' && id !== null;
  useLiveEvents(
    useCallback(
      (e) => {
        if (waiting && id && e.type === 'delivery.received' && (e.leadSourceId === id || e.leadSourceId === null)) void load(id, true).catch(() => undefined);
      },
      [waiting, id, load],
    ),
    waiting,
  );
  useEffect(() => {
    if (!waiting || !id) return;
    const t = setInterval(() => void load(id, true).catch(() => undefined), 3_000);
    return () => clearInterval(t);
  }, [waiting, id, load]);

  const fields = useMemo(() => fieldsFromDraft(draft), [draft]);
  const problems = useMemo(() => draftProblems(fields), [fields]);

  // The live preview: a dry run of the draft, debounced, whenever it is complete enough to try.
  const previewSeq = useRef(0);
  useEffect(() => {
    if (step !== 'map' || !id || !sample?.delivery) return;
    if (fields.length === 0 || problems.length > 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const seq = ++previewSeq.current;
    const t = setTimeout(() => {
      setPreviewBusy(true);
      testCustomWebhook(id, fields)
        .then((r) => {
          if (seq !== previewSeq.current) return;
          setPreview(r.preview);
          setPreviewFrom('draft');
          setPreviewError(null);
        })
        .catch((e) => {
          if (seq !== previewSeq.current) return;
          setPreviewError(errorText(e));
        })
        .finally(() => {
          if (seq === previewSeq.current) setPreviewBusy(false);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [step, id, sample?.delivery, fields, problems.length]);

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      const made = await createCustomWebhook({
        name: name.trim(),
        auth: toAuth(auth),
        ...(deliveryIdHeader.trim() ? { deliveryIdHeader: deliveryIdHeader.trim() } : {}),
      });
      setId(made.id);
      setSecret(made.secret);
      setSample({ ...made, delivery: null, format: null, paths: [], truncated: false, suggested: [] });
      setStep('waiting');
      onChanged();
    } catch (e) {
      setError({ message: errorText(e), details: errorDetails(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<boolean> => {
    if (!id) return false;
    setBusy('save');
    setError(null);
    try {
      const updated = await saveCustomWebhookMapping(id, fields);
      setSample((s) => (s ? { ...s, ...updated } : s));
      setSaved(true);
      onChanged();
      return true;
    } catch (e) {
      setError({ message: errorText(e), details: errorDetails(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveAndActivate = async () => {
    if (!id || !(await save())) return;
    setBusy('activate');
    try {
      const r = await activateCustomWebhook(id);
      setReleased(r.released);
      setSample((s) => (s ? { ...s, ...r } : s));
      setStep('done');
      onChanged();
    } catch (e) {
      setError({ message: errorText(e), details: [] });
    } finally {
      setBusy(null);
    }
  };

  const rerunSaved = async () => {
    if (!id) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const r = await testCustomWebhook(id);
      setPreview(r.preview);
      setPreviewFrom('saved');
    } catch (e) {
      setPreviewError(errorText(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const preset = AUTH_PRESETS.find((p) => p.id === auth.preset) ?? AUTH_PRESETS[0];
  const authValid =
    preset.auth !== undefined ||
    auth.preset === 'none' ||
    (auth.preset === 'basic' ? auth.username.trim().length > 0 : /^[A-Za-z0-9-]{1,64}$/.test(auth.headerName.trim()));
  const webhookUrl = sample?.webhookUrl ?? null;
  const shownPaths = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const paths = sample?.paths ?? [];
    return q ? paths.filter((p) => p.path.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)) : paths;
  }, [sample, filter]);
  const activated = sample?.custom.activated ?? false;
  const formatName = sample?.format ? (FORMAT_NAME[sample.format] ?? sample.format) : null;
  const title = step === 'setup' ? 'Add a webhook' : step === 'done' ? 'Switched on' : (sample?.name ?? 'Webhook');

  return (
    <SheetModal
      wide={step === 'map'}
      title={title}
      subtitle={
        step === 'setup'
          ? 'One URL any app or form can post a lead to. You map its fields once the first payload arrives.'
          : step === 'waiting'
            ? 'Paste the URL into your app or form tool and send one payload.'
            : step === 'map'
              ? `${formatName ? `Read as a ${formatName} form · ` : ''}Map the payload’s fields to lead fields${
                  sample?.custom.held ? ` · ${sample.custom.held} deliver${sample.custom.held === 1 ? 'y' : 'ies'} waiting` : ''
                }`
              : undefined
      }
      icon={<Webhook className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {error && <SheetError message={error.message} details={error.details} />}

      {step === 'setup' && (
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-slate-400 font-medium">Name</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. leads, Tally buyer form, Website" className={input} />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-slate-400 font-medium">How the sender proves it is them</div>
            <select className={select} value={auth.preset} onChange={(e) => setAuth({ ...auth, preset: e.target.value as AuthPreset['id'] })}>
              {AUTH_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-2xs text-slate-500 leading-relaxed">{preset.hint}</p>
          </div>
          {(auth.preset === 'header' || auth.preset === 'hmac') && (
            <div className="space-y-1">
              <div className="text-xs text-slate-400 font-medium">Header name</div>
              <input value={auth.headerName} onChange={(e) => setAuth({ ...auth, headerName: e.target.value })} placeholder="X-Webhook-Secret" className={input} />
            </div>
          )}
          {auth.preset === 'hmac' && (
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <div className="text-xs text-slate-400 font-medium">Algorithm</div>
                <select className={select} value={auth.algorithm} onChange={(e) => setAuth({ ...auth, algorithm: e.target.value as 'sha256' | 'sha1' })}>
                  <option value="sha256">SHA-256</option>
                  <option value="sha1">SHA-1</option>
                </select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-slate-400 font-medium">Encoding</div>
                <select className={select} value={auth.encoding} onChange={(e) => setAuth({ ...auth, encoding: e.target.value as 'hex' | 'base64' })}>
                  <option value="hex">hex</option>
                  <option value="base64">base64</option>
                </select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-slate-400 font-medium">Prefix (optional)</div>
                <input value={auth.prefix} onChange={(e) => setAuth({ ...auth, prefix: e.target.value })} placeholder="sha256=" className={input} />
              </div>
            </div>
          )}
          {auth.preset === 'basic' && (
            <div className="space-y-1">
              <div className="text-xs text-slate-400 font-medium">Username (we mint the password)</div>
              <input value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} placeholder="zapier" className={input} />
            </div>
          )}
          {auth.preset !== 'tally' && auth.preset !== 'typeform' && (
            <div className="space-y-1">
              <div className="text-xs text-slate-400 font-medium">Delivery-id header (optional)</div>
              <input
                value={deliveryIdHeader}
                onChange={(e) => setDeliveryIdHeader(e.target.value)}
                placeholder="X-Delivery-Id — if the app sends one, a retry never makes a second lead"
                className={input}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={secondary}>
              Cancel
            </button>
            <button type="button" onClick={() => void create()} disabled={busy !== null || !name.trim() || !authValid} className={primary}>
              {busy === 'create' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Create webhook
            </button>
          </div>
        </div>
      )}

      {step === 'waiting' && (
        <div className="space-y-4">
          {webhookUrl && <CopyField label="Webhook URL" value={webhookUrl} />}
          {secret && (
            <>
              <CopyField label="Secret" value={secret} />
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-200 leading-relaxed flex gap-2">
                <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  <strong>The secret is shown once.</strong> It is encrypted at rest and never returned again. The webhook URL can always be copied
                  from Integrations &amp; Webhooks.
                </span>
              </div>
            </>
          )}
          {webhookUrl && sample && (
            <div className="space-y-1">
              <div className="text-xs text-slate-400 font-medium">Try it from a terminal</div>
              <pre className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-2xs text-cyan-300 overflow-x-auto whitespace-pre">
                {curlExample(webhookUrl, sample.custom.auth, secret)}
              </pre>
            </div>
          )}
          <div className="text-center py-4 space-y-2">
            <Radio className="w-6 h-6 text-slate-600 mx-auto animate-pulse" />
            <div className="text-xs text-slate-400">Waiting for the first payload…</div>
            <div className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
              Nothing becomes a lead yet. The first payload is held and you map its fields next; a Tally or Typeform submission arrives already
              read as a form. The URL must be reachable from the internet — a <code className="font-mono">localhost</code> address cannot be
              called.
            </div>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={secondary}>
              Close — I’ll come back
            </button>
          </div>
        </div>
      )}

      {step === 'map' && (
        <div className="space-y-3">
          {busy === 'load' && !sample && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the last payload…
            </div>
          )}
          {sample && (
            <>
              {formatName && activated && !sample.custom.mappingConfigured && (
                <div className="text-2xs text-cyan-300 flex items-start gap-1.5">
                  <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5" />
                  Read as a {formatName} form and switched on automatically: its questions were mapped the way a connected {formatName} form is.
                  Check the mapping below; saving it makes it yours.
                </div>
              )}
              {sample.custom.dropped > 0 && (
                <div className="text-2xs text-amber-300 flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  {sample.custom.dropped} deliver{sample.custom.dropped === 1 ? 'y was' : 'ies were'} dropped while this webhook waited for a mapping: the
                  held backlog was full. Switch it on to stop losing them.
                </div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-3">
                <div className="rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-3 py-2 bg-slate-950/60 flex items-center gap-2">
                    <div className="text-2xs font-bold uppercase text-slate-500 flex-1">
                      {sample.delivery ? `Payload from ${new Date(sample.delivery.receivedAt).toLocaleString()}` : 'Payload'}
                      {sample.truncated && ' · first 500 fields'}
                    </div>
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Find a field…"
                      className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-2xs text-slate-100 focus:outline-none focus:border-emerald-500/60 w-36"
                    />
                  </div>
                  <div className="grid grid-cols-[1.2fr_1fr_1.3fr] gap-2 px-3 py-1.5 text-2xs font-bold uppercase text-slate-500 border-t border-slate-800">
                    <span>{formatName ? 'Question' : 'Path'}</span>
                    <span>Sample</span>
                    <span>Import as</span>
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-800">
                    {shownPaths.length === 0 && <div className="px-3 py-4 text-xs text-slate-500">No fields match.</div>}
                    {shownPaths.map((p) => {
                      const row: DraftRow = draft[p.path] ?? { target: '', customName: '' };
                      // Fixed-vocabulary targets need the question's option map, which only a suggestion brings.
                      const choices = TARGET_CHOICES.filter((c) => !c.enumOnly || row.transform);
                      return (
                        <div key={p.path} className="grid grid-cols-[1.2fr_1fr_1.3fr] gap-2 px-3 py-2 items-center">
                          <span className="min-w-0">
                            <span className="block text-xs text-slate-200 truncate" title={p.label}>
                              {p.label}
                            </span>
                            {p.label !== p.path && (
                              <span className="block text-2xs font-mono text-slate-500 truncate" title={p.path}>
                                {p.path}
                              </span>
                            )}
                          </span>
                          <span className="text-2xs text-slate-400 truncate" title={p.value}>
                            {p.value || <span className="text-slate-600 italic">(empty)</span>}
                          </span>
                          <div className="space-y-1">
                            <select
                              className={select}
                              value={row.target}
                              onChange={(e) => setDraft((d) => ({ ...d, [p.path]: { ...row, target: e.target.value as TargetChoice } }))}
                            >
                              {choices.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                            {row.target === '__custom__' && (
                              <input
                                value={row.customName}
                                onChange={(e) => setDraft((d) => ({ ...d, [p.path]: { ...row, customName: e.target.value } }))}
                                placeholder="Name of the extra field"
                                maxLength={60}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-2xs text-slate-100 focus:outline-none focus:border-emerald-500/60"
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-2">
                  <Preview preview={preview} loading={previewBusy} error={previewError} from={previewFrom} />
                  {sample.custom.fields.length > 0 && (
                    <button type="button" onClick={() => void rerunSaved()} disabled={previewBusy} className={`${secondary} w-full`}>
                      <Play className="w-3.5 h-3.5" /> Re-run saved mapping on last payload
                    </button>
                  )}
                </div>
              </div>

              {problems.length > 0 && (
                <ul className="text-2xs text-amber-300 list-disc pl-4 space-y-0.5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {saved && (
                <div className="flex items-center gap-1.5 text-xs text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Mapping saved.
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-2">
                <button type="button" onClick={() => void save()} disabled={busy !== null || problems.length > 0 || fields.length === 0} className={`${secondary} flex-1`}>
                  {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save mapping
                </button>
                {!activated && (
                  <button type="button" onClick={() => void saveAndActivate()} disabled={busy !== null || problems.length > 0 || fields.length === 0} className={`${primary} flex-1`}>
                    {busy === 'activate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SlidersHorizontal className="w-3.5 h-3.5" />}
                    Save &amp; switch on
                  </button>
                )}
              </div>
              <p className="text-2xs text-slate-500">
                {activated
                  ? 'This webhook is on: new payloads become leads under the saved mapping. Payloads that arrived before it was mapped were created paused, flagged for review.'
                  : 'Switching on creates leads from new payloads. The payloads held so far become leads too — paused and flagged for your review, never contacted automatically.'}
              </p>
            </>
          )}
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-xs text-slate-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              {sample?.name ?? 'The webhook'} is on. New payloads become leads as they arrive.
              {released > 0 &&
                ` ${released} payload${released === 1 ? '' : 's'} captured during setup ${released === 1 ? 'was' : 'were'} turned into leads, paused and flagged for review.`}
            </span>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={primary}>
              Done
            </button>
          </div>
        </div>
      )}
    </SheetModal>
  );
};

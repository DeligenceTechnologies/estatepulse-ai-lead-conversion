import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Globe, Loader2, MessageSquareText, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getKnowledge, knowledgeSize, saveKnowledge, type KnowledgeEntry, type KnowledgeLimits } from '../../utils/knowledgeApi';
import {
  addKnowledgeWebsite,
  getKnowledgeSources,
  removeKnowledgeSource,
  uploadKnowledgeFile,
  type KnowledgeSourcesStatus,
} from '../../utils/knowledgeSourcesApi';
import { Button, IconButton } from '../common/Button';

/**
 * Everything the AI knows about this office, in one list: short answers the
 * owner typed, documents they uploaded, and pages of their website. The owner
 * adds any of the three from the same row of buttons, and each one is saved the
 * moment it is added — there is no separate save step. Anything the list does
 * not cover, the AI promises to check rather than guessing at.
 *
 * Typed answers ride in the assistant's prompt; documents and websites live in
 * the organization's Telnyx knowledge base. The owner does not need to know the
 * difference, so this card does not show it.
 */

const FALLBACK_LIMITS: KnowledgeLimits = { maxEntries: 25, titleMaxChars: 80, bodyMaxChars: 400, totalMaxChars: 4000 };
/** While a document or site is still being read, the list is refreshed on this beat. */
const POLL_MS = 5000;
/** After something is added the list keeps refreshing this long: a website's pages arrive one by one. */
const WATCH_MS = 3 * 60_000;

type Form = { kind: 'answer'; index: number | null; title: string; body: string } | { kind: 'website'; url: string } | null;

const inputClass =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';
const rowClass = 'border border-slate-800 bg-slate-950/60 rounded-xl px-3 py-2.5 flex items-center gap-3';

export const KnowledgeCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [limits, setLimits] = useState<KnowledgeLimits>(FALLBACK_LIMITS);
  const [docs, setDocs] = useState<KnowledgeSourcesStatus | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [watching, setWatching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshDocs = useCallback(() => getKnowledgeSources().then(setDocs), []);

  useEffect(() => {
    const answers = getKnowledge().then((r) => {
      setEntries(r.entries);
      setLimits(r.limits);
    });
    // Documents need Telnyx; when they cannot be loaded the typed answers still work.
    const sources = refreshDocs().catch(() => setDocs(null));
    Promise.all([answers, sources])
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, [refreshDocs]);

  const reading = docs?.sources.some((s) => s.status === 'processing') ?? false;
  useEffect(() => {
    if (!reading && !watching) return;
    const timer = window.setInterval(() => void refreshDocs().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reading, watching, refreshDocs]);
  useEffect(() => {
    if (!watching) return;
    const timer = window.setTimeout(() => setWatching(false), WATCH_MS);
    return () => window.clearTimeout(timer);
  }, [watching]);

  const canAddDocs = Boolean(docs?.available && !docs.managedInTelnyx);
  const sources = docs?.sources ?? [];
  const empty = entries.length === 0 && sources.length === 0;
  const maxMb = docs ? Math.floor(docs.limits.maxFileBytes / (1024 * 1024)) : 20;
  const accept = (docs?.limits.fileTypes ?? ['pdf', 'txt', 'md', 'html', 'htm', 'csv', 'json']).map((t) => `.${t}`).join(',');

  /** Saves the whole list of typed answers; `done` is what the owner is told. */
  const saveAnswers = async (next: KnowledgeEntry[], key: string, done: string) => {
    setBusy(key);
    try {
      const r = await saveKnowledge(next);
      setEntries(r.entries);
      setLimits(r.limits);
      setForm(null);
      if (r.warning) toast.warn(r.warning);
      else toast.success(done);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const submitAnswer = (f: Extract<Form, { kind: 'answer' }>) => {
    const entry = { title: f.title.trim(), body: f.body.trim() };
    const next = f.index === null ? [...entries, entry] : entries.map((e, i) => (i === f.index ? entry : e));
    void saveAnswers(next, 'form', f.index === null ? 'Added. The AI uses it from the next call or chat.' : 'Saved.');
  };

  const submitWebsite = async (url: string) => {
    setBusy('form');
    try {
      setDocs(await addKnowledgeWebsite(url));
      setForm(null);
      toast.success('Website added. Its pages appear here as they are read.');
      setWatching(true);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    if (docs && file.size > docs.limits.maxFileBytes) {
      toast.error(`That file is too large. The limit is ${maxMb} MB.`);
      return;
    }
    setForm(null);
    setUploading(0);
    try {
      setDocs(await uploadKnowledgeFile(file, setUploading));
      toast.success('Document uploaded. The AI can use it in a moment.');
      setWatching(true);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setUploading(null);
    }
  };

  const removeSource = async (name: string) => {
    setBusy(`source:${name}`);
    try {
      setDocs(await removeKnowledgeSource(name));
      toast.success('Removed. The AI no longer answers from it.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const size = form?.kind === 'answer' ? knowledgeSize(entries.filter((_, i) => i !== form.index).concat({ title: form.title, body: form.body })) : 0;
  const overBudget = size > limits.totalMaxChars;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-emerald-400" />
          Knowledge
        </h3>
        <p className="text-xs text-slate-400 mt-1 max-w-2xl">
          What your AI answers from, on calls and in texts. If a lead asks something that is not here, it says it will
          check and have an agent confirm.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading knowledge…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus />}
              disabled={entries.length >= limits.maxEntries}
              onClick={() => setForm({ kind: 'answer', index: null, title: '', body: '' })}
            >
              Write an answer
            </Button>
            <input ref={fileInput} type="file" accept={accept} className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
            <Button variant="secondary" size="sm" icon={<Upload />} disabled={!canAddDocs} loading={uploading !== null} onClick={() => fileInput.current?.click()}>
              {uploading !== null ? `Uploading ${Math.round(uploading * 100)}%` : 'Upload a document'}
            </Button>
            <Button variant="secondary" size="sm" icon={<Globe />} disabled={!canAddDocs} onClick={() => setForm({ kind: 'website', url: '' })}>
              Add your website
            </Button>
          </div>

          {docs && !docs.available && (
            <p className="text-[11px] text-slate-500">Connect Telnyx and create your AI assistant to add documents and websites.</p>
          )}
          {docs?.managedInTelnyx && (
            <p className="text-[11px] text-amber-300">This assistant's documents are managed in your Telnyx portal, so they can only be changed there.</p>
          )}

          {form?.kind === 'answer' && (
            <form
              className="border border-emerald-800/50 bg-slate-950/60 rounded-xl p-3 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitAnswer(form);
              }}
            >
              <input
                autoFocus
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Question or topic — e.g. Which areas do you cover?"
                maxLength={limits.titleMaxChars}
                className={`${inputClass} font-semibold`}
              />
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="What the AI should say — e.g. Plano, Frisco, McKinney and Allen."
                maxLength={limits.bodyMaxChars}
                rows={2}
                className={`${inputClass} resize-y`}
              />
              <div className="flex items-center justify-end gap-2">
                {overBudget && <span className="text-xs text-amber-300 mr-auto">That is more than the AI can carry. Shorten it, or upload it as a document.</span>}
                <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" loading={busy === 'form'} disabled={!form.title.trim() || !form.body.trim() || overBudget}>
                  {form.index === null ? 'Add' : 'Save'}
                </Button>
              </div>
            </form>
          )}

          {form?.kind === 'website' && (
            <form
              className="border border-emerald-800/50 bg-slate-950/60 rounded-xl p-3 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submitWebsite(form.url);
              }}
            >
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://www.yourbrokerage.com"
                  maxLength={2000}
                  className={inputClass}
                />
                <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" loading={busy === 'form'} disabled={!form.url.trim()}>
                  Add
                </Button>
              </div>
              <p className="text-[11px] text-slate-500">The AI reads this page and the pages it links to on your site.</p>
            </form>
          )}

          {empty && !form ? (
            <p className="text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl p-4">
              Nothing yet. Start with the questions leads ask you every week — the areas you cover, your commission, the
              lenders you work with — or upload a guide you already have.
            </p>
          ) : (
            <ul className="space-y-2">
              {entries.map((e, i) =>
                form?.kind === 'answer' && form.index === i ? null : (
                  <li key={`answer-${i}`} className={rowClass}>
                    <MessageSquareText className="w-4 h-4 text-slate-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-white truncate">{e.title}</p>
                      <p className="text-[11px] text-slate-400 truncate">{e.body}</p>
                    </div>
                    <IconButton size="sm" onClick={() => setForm({ kind: 'answer', index: i, ...e })} aria-label={`Edit ${e.title}`} icon={<Pencil />} />
                    <IconButton
                      size="sm"
                      className="hover:text-rose-300!"
                      loading={busy === `answer:${i}`}
                      disabled={busy !== null}
                      onClick={() => void saveAnswers(entries.filter((_, k) => k !== i), `answer:${i}`, 'Removed. The AI no longer answers from it.')}
                      aria-label={`Remove ${e.title}`}
                      icon={<Trash2 />}
                    />
                  </li>
                ),
              )}
              {sources.map((s) => (
                <li key={`source-${s.name}`} className={rowClass}>
                  {s.kind === 'website' ? <Globe className="w-4 h-4 text-slate-500 shrink-0" /> : <FileText className="w-4 h-4 text-slate-500 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-white truncate" title={s.name}>
                      {s.name.replace(/^https?:\/\//i, '')}
                    </p>
                    {s.status === 'failed' && (
                      <p className="text-[11px] text-rose-300 truncate" title={s.error ?? undefined}>
                        Could not be read{s.error ? `: ${s.error}` : '. Remove it and try another file.'}
                      </p>
                    )}
                  </div>
                  {s.status === 'processing' && (
                    <span className="text-[11px] text-amber-300 flex items-center gap-1.5 whitespace-nowrap">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Reading
                    </span>
                  )}
                  {!docs?.managedInTelnyx && (
                    <IconButton
                      size="sm"
                      className="hover:text-rose-300!"
                      loading={busy === `source:${s.name}`}
                      disabled={busy !== null}
                      onClick={() => void removeSource(s.name)}
                      aria-label={`Remove ${s.name}`}
                      icon={<Trash2 />}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {canAddDocs && (
            <p className="text-[11px] text-slate-500">Documents: PDF, text, HTML, CSV or JSON, up to {maxMb} MB. Save a Word file as PDF first.</p>
          )}
        </>
      )}
    </div>
  );
};

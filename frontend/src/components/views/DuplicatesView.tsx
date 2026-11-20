import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, GitMerge, Inbox, Loader2, MessageSquare, PhoneCall, RefreshCw, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { useOpenLead } from '../leads/useOpenLead';
import {
  dismissDuplicate,
  listDuplicates,
  mergeDuplicate,
  scanDuplicates,
  type DuplicateLeadSummary,
  type DuplicatePair,
  type DuplicateStatus,
} from '../../utils/duplicatesApi';
import { errorText } from '../sheets/SheetModal';
import { Button } from '../common/Button';

const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl shadow-lg';
const PAGE = 20;

const FIELD_LABEL: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  phone: 'Phone',
  email: 'Email',
  location: 'Location',
  timeline: 'Timeline',
  minBudget: 'Budget min',
  maxBudget: 'Budget max',
  status: 'Status',
};

const statusLabel = (s: string) => s.replace(/_/g, ' ');
const money = (n: number | null) => (n === null ? null : `$${Math.round(n / 1000)}k`);
const budget = (l: DuplicateLeadSummary) => {
  const lo = money(l.minBudget);
  const hi = money(l.maxBudget);
  return lo || hi ? (lo === hi ? lo : `${lo ?? '…'}–${hi ?? '…'}`) : null;
};

function scoreTone(score: number) {
  if (score >= 100) return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  if (score >= 80) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return 'bg-slate-500/15 text-slate-300 border-slate-600';
}

/** One side of a pair: the lead's facts, with the fields that differ from the other side marked. */
const LeadSide: React.FC<{
  lead: DuplicateLeadSummary;
  differences: string[];
  keep: boolean;
  selectable: boolean;
  onKeep: () => void;
  onOpen: () => void;
}> = ({ lead, differences, keep, selectable, onKeep, onOpen }) => {
  const row = (field: string, label: string, value: React.ReactNode) => (
    <div className="flex items-baseline gap-2 text-xs min-w-0">
      <span className="w-16 shrink-0 text-slate-500">{label}</span>
      <span className={`truncate ${differences.includes(field) ? 'text-amber-200' : 'text-slate-200'}`} title={typeof value === 'string' ? value : undefined}>
        {value || <span className="text-slate-600">—</span>}
      </span>
    </div>
  );
  return (
    <div
      className={`flex-1 min-w-0 rounded-xl border p-3 space-y-2 transition-colors ${
        keep ? 'border-emerald-500/50 bg-emerald-500/[0.05]' : 'border-slate-800 bg-slate-950/40'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="text-left min-w-0 cursor-pointer group" title="Open this lead">
          <div className="text-sm font-semibold text-white truncate group-hover:underline">{lead.name}</div>
          <div className="text-2xs text-slate-500">
            Added {new Date(lead.createdAt).toLocaleDateString()} · {lead.source?.name ?? 'Added by hand'}
          </div>
        </button>
        {selectable && (
          <button
            type="button"
            onClick={onKeep}
            aria-pressed={keep}
            className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-semibold border cursor-pointer transition-colors ${
              keep ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'text-slate-400 border-slate-700 hover:text-white'
            }`}
          >
            {keep ? <Check className="w-3 h-3" /> : null}
            {keep ? 'Keep this one' : 'Keep this'}
          </button>
        )}
      </div>
      <div className="space-y-1">
        {row('phone', 'Phone', lead.phone)}
        {row('email', 'Email', lead.email)}
        {row('status', 'Status', <span className="capitalize">{statusLabel(lead.status)}</span>)}
        {row('location', 'Location', lead.location)}
        {row('minBudget', 'Budget', budget(lead))}
        {row('assigned', 'Agent', lead.assignedAgent?.name ?? null)}
      </div>
      <div className="flex items-center gap-3 pt-1 text-2xs text-slate-400">
        <span className="inline-flex items-center gap-1" title="Texts">
          <MessageSquare className="w-3 h-3" /> {lead.activity.messages}
        </span>
        <span className="inline-flex items-center gap-1" title="Calls">
          <PhoneCall className="w-3 h-3" /> {lead.activity.calls}
        </span>
        {lead.submissionCount > 1 && <span title="Times this person submitted">{lead.submissionCount} submissions</span>}
        {lead.dncStatus && <span className="text-rose-300">Do not contact</span>}
      </div>
    </div>
  );
};

const PairCard: React.FC<{ pair: DuplicatePair; onDone: () => void }> = ({ pair, onDone }) => {
  const openLead = useOpenLead();
  const [keep, setKeep] = useState(pair.suggestedSurvivorId);
  const [busy, setBusy] = useState<'merge' | 'dismiss' | null>(null);
  const [armed, setArmed] = useState(false);
  const open = pair.status === 'open';
  const survivor = keep === pair.leadA.id ? pair.leadA : pair.leadB;
  const merged = keep === pair.leadA.id ? pair.leadB : pair.leadA;

  const merge = async () => {
    if (!armed) return setArmed(true);
    setBusy('merge');
    try {
      await mergeDuplicate(pair.id, keep);
      toast.success(`Merged — ${merged.name}'s history is now on ${survivor.name}. You can undo it from the lead.`);
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      onDone();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
      setArmed(false);
    }
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try {
      await dismissDuplicate(pair.id);
      onDone();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`${card} p-4 space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded-md border text-2xs font-bold ${scoreTone(pair.score)}`} title="How sure the match is">
          {pair.score >= 100 ? 'Strong match' : pair.score >= 80 ? 'Likely match' : 'Possible match'}
        </span>
        {pair.reasons.map((r) => (
          <span key={r} className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 text-2xs">
            {r}
          </span>
        ))}
        <div className="flex-1" />
        {pair.differences.length > 0 && (
          <span className="text-2xs text-slate-500" title="Fields that differ are highlighted">
            Differs in {pair.differences.map((f) => FIELD_LABEL[f] ?? f).join(', ')}
          </span>
        )}
      </div>

      <div className="flex flex-col md:flex-row items-stretch gap-3">
        <LeadSide
          lead={pair.leadA}
          differences={pair.differences}
          keep={open && keep === pair.leadA.id}
          selectable={open}
          onKeep={() => setKeep(pair.leadA.id)}
          onOpen={() => void openLead(pair.leadA.id)}
        />
        <LeadSide
          lead={pair.leadB}
          differences={pair.differences}
          keep={open && keep === pair.leadB.id}
          selectable={open}
          onKeep={() => setKeep(pair.leadB.id)}
          onOpen={() => void openLead(pair.leadB.id)}
        />
      </div>

      {open ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
          <p className="text-2xs text-slate-400 flex items-center gap-1 min-w-0">
            <span className="truncate">{merged.name}</span>
            <ArrowRight className="w-3 h-3 shrink-0" />
            <span className="truncate text-slate-200">{survivor.name}</span>
            <span className="hidden sm:inline">— texts, calls, meetings and sources move over; blanks are filled, nothing is overwritten.</span>
          </p>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" icon={<X />} loading={busy === 'dismiss'} disabled={busy !== null} onClick={() => void dismiss()}>
            Not the same person
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<GitMerge />}
            loading={busy === 'merge'}
            disabled={busy !== null}
            onClick={() => void merge()}
            onBlur={() => setArmed(false)}
          >
            {armed ? 'Click again to merge' : 'Merge'}
          </Button>
        </div>
      ) : (
        <p className="text-2xs text-slate-500 border-t border-slate-800 pt-3">
          {pair.status === 'merged' ? 'Merged' : 'Dismissed'}
          {pair.resolvedAt ? ` on ${new Date(pair.resolvedAt).toLocaleString()}` : ''}
        </p>
      )}
    </div>
  );
};

/**
 * Leads that look like the same person. Anyone arriving with a phone or email that is already a
 * lead's is attached to that lead automatically; what is here are the rest — older duplicates and
 * near matches (a different country code, the same Gmail inbox) — for a person to merge or dismiss.
 * A name alone never makes a pair: people are told apart by phone and email only.
 */
export const DuplicatesView: React.FC = () => {
  const [tab, setTab] = useState<DuplicateStatus>('open');
  const [items, setItems] = useState<DuplicatePair[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(
    async (more = false) => {
      setLoading(true);
      try {
        const r = await listDuplicates(tab, PAGE, more ? items.length : 0);
        setItems((prev) => (more ? [...prev, ...r.items] : r.items));
        setTotal(r.total);
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await scanDuplicates();
      toast.info(r.added ? `${r.added} new possible duplicate${r.added === 1 ? '' : 's'} found.` : 'No new duplicates found.');
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setScanning(false);
    }
  };

  const remove = (id: string) => {
    setItems((prev) => prev.filter((p) => p.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Duplicates</h2>
          <p className="text-xs text-slate-400">
            Leads that look like the same person. Merging keeps one lead with everyone's texts, calls and sources; it can be undone from the lead.
          </p>
        </div>
        <Button variant="outline" size="sm" icon={<RefreshCw />} loading={scanning} onClick={() => void scan()} title="Look through every lead for duplicates now">
          {scanning ? 'Scanning…' : 'Scan now'}
        </Button>
      </div>

      <div role="tablist" className="inline-flex items-center gap-1 p-1 bg-slate-950/70 border border-slate-800 rounded-xl">
        {(
          [
            ['open', 'To review'],
            ['merged', 'Merged'],
            ['dismissed', 'Not duplicates'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
              tab === id ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
            }`}
          >
            {label}
            {tab === id && !loading && (
              <span className="min-w-5 px-1.5 rounded-full text-2xs font-bold text-center bg-slate-500/15 text-slate-300">{total}</span>
            )}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className={`${card} p-10 text-center space-y-2`}>
          {tab === 'open' ? <Copy className="w-6 h-6 mx-auto text-slate-500" /> : <Inbox className="w-6 h-6 mx-auto text-slate-500" />}
          <p className="text-sm text-slate-300">{tab === 'open' ? 'No duplicates to review.' : tab === 'merged' ? 'Nothing merged yet.' : 'Nothing dismissed.'}</p>
          {tab === 'open' && (
            <p className="text-xs text-slate-500">New submissions from a known phone or email are added to the existing lead on their own.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((p) => (
            <PairCard key={p.id} pair={p} onDone={() => remove(p.id)} />
          ))}
          {items.length < total && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" loading={loading} onClick={() => void load(true)}>
                Show more ({total - items.length})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Inbox, Loader2 } from 'lucide-react';
import { useLiveEvents } from '../../lib/liveEvents';
import {
  approveRows,
  listSheetSources,
  rejectRows,
  resolveChanges,
  reviewQueue,
  sheetChanges,
  syncSheetSource,
  type ChangeItem,
  type ReviewItem,
  type SheetSource,
} from '../../utils/googleSheetsApi';
import { FIELD_LABEL, approveMessage, formatValue, rejectMessage } from '../../utils/sheetMapping';
import { errorText } from '../sheets/SheetModal';

/** The review reason every import starts with; shown as the screen itself, not as a badge. */
const IMPORT_REASON = 'Imported from Google Sheets — awaiting owner approval';
/** The API decides at most this many rows per request. */
const DECISION_BATCH = 500;

type Tab = 'pending' | 'rejected' | 'changes';
type Notice = { tone: 'ok' | 'error'; text: string } | null;

const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl shadow-lg';
const btn =
  'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5';

function budget(min: number | null, max: number | null): string {
  if (min === null && max === null) return '—';
  const f = (n: number | null) => (n === null ? '…' : `$${Math.round(n / 1000)}k`);
  return min === max ? f(min) : `${f(min)}–${f(max)}`;
}

/** Decide in batches the API accepts; one message for the whole selection. */
async function inBatches<T>(ids: string[], fn: (batch: string[]) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += DECISION_BATCH) out.push(await fn(ids.slice(i, i + DECISION_BATCH)));
  return out;
}

/**
 * Leads imported from Google Sheets, waiting for the owner. Nothing here
 * contacts anyone: approving makes a lead eligible for the outreach strategy,
 * which picks it up on its own schedule and re-checks its own rules.
 *
 * No background polling: the list reloads when a sheet imports something (the
 * live stream's lead.created), after every decision, and after "Sync now".
 */
export const ImportReviewView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('pending');
  const [sources, setSources] = useState<SheetSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ pending?: number; rejected?: number }>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'more' | 'approve' | 'reject' | 'apply' | 'keep'>(null);
  const [armed, setArmed] = useState<null | 'approve' | 'reject' | 'apply' | 'keep'>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const changeSource = tab === 'changes' ? sourceId || (sources.length === 1 ? sources[0].id : '') : sourceId;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listSheetSources();
      setSources(list);
      if (tab !== 'changes') {
        const page = await reviewQueue({
          state: tab,
          sourceId: sourceId || undefined,
          limit: 50,
        });
        setItems(page.items);
        setCursor(page.nextCursor);
        setTotals((t) => ({ ...t, [tab]: page.total }));
        setSelected((s) => new Set([...s].filter((id) => page.items.some((i) => i.rowId === id))));
      } else {
        const src = sourceId || (list.length === 1 ? list[0].id : '');
        const found = src ? await sheetChanges(src) : [];
        setChanges(found);
        setSelected((s) => new Set([...s].filter((id) => found.some((c) => c.rowId === id))));
      }
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [tab, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveEvents(
    useCallback(
      (e) => {
        if (e.type === 'lead.created' && sources.some((s) => s.id === e.leadSourceId)) void load();
      },
      [sources, load],
    ),
  );

  const switchTab = (t: Tab) => {
    setTab(t);
    setItems([]);
    setCursor(null);
    setSelected(new Set());
    setArmed(null);
    setNotice(null);
  };

  const more = async () => {
    if (!cursor) return;
    setBusy('more');
    try {
      const page = await reviewQueue({
        state: tab === 'rejected' ? 'rejected' : 'pending',
        sourceId: sourceId || undefined,
        cursor,
        limit: 50,
      });
      setItems((xs) => [...xs, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Only a switched-on sheet can sync (the API refuses a paused one).
  const syncTargets = useMemo(() => sources.filter((s) => s.status === 'ACTIVE' && (!sourceId || s.id === sourceId)), [sources, sourceId]);
  const [syncing, setSyncing] = useState(false);
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts twice in development, and the first
  // cleanup must not leave the second mount thinking it is gone.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Ask the server to read the sheets now, then follow those syncs until they
   * settle — an edit or a deletion raises no live event, so this is how the
   * screen learns the sync is done.
   * ponytail: follows for at most ~2 minutes; a longer sync shows on the next refresh.
   */
  const sync = async () => {
    const ids = syncTargets.map((s) => s.id);
    const failedBefore = new Map(sources.map((s) => [s.id, s.lastFailureAt]));
    setSyncing(true);
    setNotice(null);
    try {
      await Promise.all(ids.map((id) => syncSheetSource(id)));
      let list = await listSheetSources();
      const running = () => list.some((s) => ids.includes(s.id) && (s.syncing || s.syncQueued));
      for (let i = 0; i < 120 && alive.current && running(); i++) {
        await new Promise((r) => setTimeout(r, 1_000));
        list = await listSheetSources();
      }
      const failed = list.filter((s) => ids.includes(s.id) && s.lastFailureAt && s.lastFailureAt !== failedBefore.get(s.id));
      setNotice(
        failed.length > 0
          ? {
              tone: 'error',
              text: failed.map((s) => `${s.name}: ${s.lastErrorMessage ?? s.lastErrorCode}`).join(' '),
            }
          : running()
            ? {
                tone: 'ok',
                text: 'Still syncing — refresh in a moment to see the rest.',
              }
            : {
                tone: 'ok',
                text: `Synced ${ids.length === 1 ? 'the sheet' : `${ids.length} sheets`} with Google.`,
              },
      );
      await load();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setSyncing(false);
    }
  };

  // What the checkboxes can select: rejected rows are read-only here.
  const visibleIds = useMemo(
    () => (tab === 'pending' ? items.map((i) => i.rowId) : tab === 'changes' ? changes.map((c) => c.rowId) : []),
    [tab, items, changes],
  );
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** Two clicks for every decision: the first arms, the second acts. */
  const decide = async (what: 'approve' | 'reject' | 'apply' | 'keep') => {
    if (armed !== what) {
      setArmed(what);
      return;
    }
    setArmed(null);
    setBusy(what);
    setNotice(null);
    const ids = [...selected];
    try {
      if (what === 'approve') {
        const rs = await inBatches(ids, approveRows);
        const merged = rs.reduce((a, r) => ({
          approved: a.approved + r.approved,
          released: a.released + r.released,
          held: [...a.held, ...r.held],
          skipped: [...a.skipped, ...r.skipped],
        }));
        setNotice({ tone: 'ok', text: approveMessage(merged) });
      } else if (what === 'reject') {
        const rs = await inBatches(ids, rejectRows);
        setNotice({
          tone: 'ok',
          text: rejectMessage(
            rs.reduce((a, r) => ({
              rejected: a.rejected + r.rejected,
              skipped: [...a.skipped, ...r.skipped],
            })),
          ),
        });
      } else {
        const rs = await inBatches(ids, (b) => resolveChanges(b, what));
        const n = rs.reduce((a, r) => a + r.resolved, 0);
        setNotice({
          tone: 'ok',
          text:
            what === 'apply'
              ? `Updated ${n} lead${n === 1 ? '' : 's'} with the sheet’s values.`
              : `Kept ${n} lead${n === 1 ? '' : 's'} as reviewed. The sheet’s change will not be raised again.`,
        });
      }
      setSelected(new Set());
      await load();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const decisionButton = (what: 'approve' | 'reject' | 'apply' | 'keep', label: string, cls: string) => (
    <button
      type="button"
      className={`${btn} ${armed === what ? 'bg-amber-500 text-slate-950' : cls}`}
      disabled={selected.size === 0 || busy !== null}
      onClick={() => void decide(what)}
      onBlur={() => armed === what && setArmed(null)}
    >
      {busy === what && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {armed === what ? `Click again to ${label.toLowerCase()} ${selected.size}` : `${label} (${selected.size})`}
    </button>
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Import Review</h2>
          <p className="text-xs text-slate-400">
            Leads from your Google Sheets wait here. Nobody is called or texted until you approve them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={tab === 'changes' ? changeSource : sourceId}
            onChange={(e) => {
              setSourceId(e.target.value);
              setSelected(new Set());
            }}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100 max-w-[16rem]"
          >
            <option value="">{tab === 'changes' ? 'Choose a sheet…' : 'All sheets'}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void sync()}
            disabled={syncing || syncTargets.length === 0}
            title={
              syncTargets.length === 0
                ? 'No sheet here is switched on. Switch one on in Integrations to sync it.'
                : `Read ${sourceId ? 'this sheet' : 'every switched-on sheet'} from Google now`
            }
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      <div className={`${card} p-4 space-y-3`}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
          {(
            [
              ['pending', `Waiting for review${totals.pending !== undefined ? ` (${totals.pending})` : ''}`],
              ['changes', 'Changed in the sheet'],
              ['rejected', `Rejected${totals.rejected !== undefined ? ` (${totals.rejected})` : ''}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => switchTab(id)}
              className={`${btn} ${tab === id ? 'bg-green-600/20 text-green-300 border border-green-500/40' : 'text-slate-400 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          {tab === 'pending' ? (
            <>
              {decisionButton('reject', 'Reject', 'bg-slate-800 text-slate-200 hover:bg-rose-600/30')}
              {decisionButton('approve', 'Approve', 'bg-green-600 text-white hover:bg-green-500')}
            </>
          ) : tab === 'rejected' ? null : (
            <>
              {decisionButton('keep', 'Keep current', 'bg-slate-800 text-slate-200 hover:bg-slate-700')}
              {decisionButton('apply', 'Apply sheet values', 'bg-green-600 text-white hover:bg-green-500')}
            </>
          )}
        </div>

        {notice && (
          <div
            className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
              notice.tone === 'ok'
                ? 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30'
                : 'text-rose-300 bg-rose-500/10 border-rose-500/30'
            }`}
          >
            {notice.tone === 'ok' ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            )}
            <span>{notice.text}</span>
          </div>
        )}

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => void load()} className="font-bold underline cursor-pointer">
              Retry
            </button>
          </div>
        )}

        {loading && (tab === 'changes' ? changes.length === 0 : items.length === 0) && (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {/* Waiting for review, and rejected (read-only) */}
        {tab !== 'changes' && !loading && items.length === 0 && !error && (
          <div className="text-center py-10 space-y-2">
            <Inbox className="w-7 h-7 text-slate-600 mx-auto" />
            <div className="text-xs text-slate-400">
              {tab === 'pending' ? 'No imported leads are waiting for review.' : 'No imported leads have been rejected.'}
            </div>
          </div>
        )}
        {tab !== 'changes' && items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-2xs uppercase text-slate-500 text-left">
                <tr>
                  {tab === 'pending' && (
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
                        aria-label="Select all shown"
                      />
                    </th>
                  )}
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Phone</th>
                  <th className="px-2 py-2">Email</th>
                  <th className="px-2 py-2">Location</th>
                  <th className="px-2 py-2">Budget</th>
                  <th className="px-2 py-2">Sheet</th>
                  {/* As wide as its badges: the other columns take the spare width. */}
                  <th className="px-2 py-2 w-px whitespace-nowrap">{tab === 'pending' ? 'Warnings' : 'Rejected'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {items.map((i) => {
                  // Our checks on the row (a bad email, a possible duplicate) — not the sheet's own notes column.
                  const warnings = (i.lead?.reviewReasons ?? []).filter((r) => r !== IMPORT_REASON);
                  return (
                    <tr key={i.rowId} className={selected.has(i.rowId) ? 'bg-green-500/5' : ''}>
                      {tab === 'pending' && (
                        <td className="px-2 py-2">
                          <input
                            type="checkbox"
                            checked={selected.has(i.rowId)}
                            onChange={() => toggle(i.rowId)}
                            aria-label="Select lead"
                          />
                        </td>
                      )}
                      <td className="px-2 py-2 text-slate-100">{[i.lead?.firstName, i.lead?.lastName].filter(Boolean).join(' ') || '—'}</td>
                      <td className="px-2 py-2 text-slate-300">{i.lead?.phone ?? '—'}</td>
                      <td className="px-2 py-2 text-slate-300">{i.lead?.email ?? '—'}</td>
                      <td className="px-2 py-2 text-slate-400">{i.lead?.location ?? '—'}</td>
                      <td className="px-2 py-2 text-slate-400">{budget(i.lead?.minBudget ?? null, i.lead?.maxBudget ?? null)}</td>
                      <td className="px-2 py-2 text-slate-500" title={i.source?.name}>
                        row {i.rowNumber}
                      </td>
                      {tab === 'rejected' ? (
                        <td className="px-2 py-2 text-slate-500 whitespace-nowrap">
                          {i.reviewedAt ? new Date(i.reviewedAt).toLocaleDateString() : '—'}
                        </td>
                      ) : (
                        <td className="px-2 py-2">
                          <div className="flex gap-1 whitespace-nowrap">
                            {i.lead?.dncStatus && (
                              <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded border bg-rose-500/20 text-rose-300 border-rose-500/40">
                                do not contact
                              </span>
                            )}
                            {i.missing && (
                              <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded border bg-slate-800 text-slate-400 border-slate-700">
                                removed from sheet
                              </span>
                            )}
                            {warnings.length > 0 && (
                              <span
                                className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/40 flex items-center gap-1 cursor-help"
                                title={warnings.join('\n')}
                              >
                                <AlertTriangle className="w-3 h-3" />
                                {warnings.length} warning{warnings.length === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {cursor && (
              <button
                type="button"
                onClick={() => void more()}
                disabled={busy !== null}
                className={`${btn} mx-auto mt-3 text-slate-300 hover:text-white`}
              >
                {busy === 'more' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Load more
              </button>
            )}
          </div>
        )}

        {/* Changed in the sheet after review */}
        {tab === 'changes' && !changeSource && !loading && (
          <div className="text-center py-10 text-xs text-slate-400">Choose a sheet to see rows that changed after you reviewed them.</div>
        )}
        {tab === 'changes' && changeSource && !loading && changes.length === 0 && !error && (
          <div className="text-center py-10 space-y-2">
            <Inbox className="w-7 h-7 text-slate-600 mx-auto" />
            <div className="text-xs text-slate-400">No reviewed rows have changed in the sheet.</div>
          </div>
        )}
        {tab === 'changes' && changes.length > 0 && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-2xs text-slate-500">
              <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))} />
              Select all
            </label>
            {changes.map((c) => (
              <div
                key={c.rowId}
                className={`rounded-xl border p-3 space-y-2 ${selected.has(c.rowId) ? 'border-green-500/40' : 'border-slate-800'}`}
              >
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={selected.has(c.rowId)} onChange={() => toggle(c.rowId)} aria-label="Select change" />
                  <span className="text-xs font-bold text-slate-100">
                    {[c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(' ') || 'Lead'}
                  </span>
                  <span className="text-2xs text-slate-500">
                    row {c.rowNumber} · {c.reviewState} · changed {new Date(c.changedAt).toLocaleString()}
                  </span>
                </div>
                {c.incomingDoNotContact && (
                  <div className="text-2xs text-rose-300">
                    The new contact details belong to someone who opted out. Applying keeps this lead from being contacted.
                  </div>
                )}
                <table className="w-full text-2xs">
                  <thead className="text-slate-500 text-left">
                    <tr>
                      <th className="py-1 pr-2 font-semibold">Field</th>
                      <th className="py-1 pr-2 font-semibold">On the lead now</th>
                      <th className="py-1 font-semibold">In the sheet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.diff.map((d) => (
                      <tr key={d.field}>
                        <td className="py-1 pr-2 text-slate-400">{FIELD_LABEL[d.field] ?? d.field}</td>
                        <td className="py-1 pr-2 text-slate-300">{formatValue(d.current)}</td>
                        <td className="py-1 text-amber-200">{formatValue(d.incoming)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

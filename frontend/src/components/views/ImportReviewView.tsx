import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Ban, FileSpreadsheet, FileUp, FileX, History, Inbox, Loader2, PhoneOff } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { useLiveEvents } from '../../lib/liveEvents';
import { getCrmStatus } from '../../utils/crmApi';
import { importHistory, type ImportBatch } from '../../utils/fileImportApi';
import {
  approveRows,
  isSheetsDisabled,
  listSheetSources,
  rejectRows,
  resolveChanges,
  reviewQueue,
  sheetChanges,
  syncSheetSource,
  type ChangeItem,
  type ImportKind,
  type ReviewItem,
  type SheetSource,
} from '../../utils/googleSheetsApi';
import { getOutreachConfig, type OutreachChoice, type OutreachConfig } from '../../utils/outreachApi';
import { FIELD_LABEL, approveMessage, formatValue, rejectMessage } from '../../utils/sheetMapping';
import { ApproveOutreachModal } from '../imports/ApproveOutreachModal';
import { FileImportModal } from '../imports/FileImportModal';
import { OutreachBatches } from '../imports/OutreachBatches';
import { ImportHistoryModal, SourceBadge } from '../imports/ImportHistoryModal';
import { errorText } from '../sheets/SheetModal';

/** The review reasons every import starts with; shown as the screen itself, not as badges. */
const IMPORT_REASONS = [
  'Imported from Google Sheets — awaiting owner approval',
  'Imported from a file — awaiting owner approval',
  'Imported from HubSpot — awaiting owner approval',
];

/** What a row's source is called on hover, and whether it has a row number worth showing (a CRM record has none). */
const KIND_NAME: Record<ImportKind, string> = { google_sheets: 'Google Sheet', file_upload: 'Uploaded file', hubspot: 'HubSpot' };
/** The API decides at most this many rows per request. */
const DECISION_BATCH = 500;

/**
 * Nothing an owner would want a second look at: no warning, no opt-out, still in the sheet, a phone to call. Ticked on arrival.
 * No phone at all carries no warning (email alone makes a lead), but approving it keeps it paused; a phone that did not parse is warned already.
 */
const clean = (i: ReviewItem): boolean =>
  !i.missing && !i.lead?.dncStatus && !!i.lead?.phone && (i.lead?.reviewReasons ?? []).every((r) => IMPORT_REASONS.includes(r));

type Tab = 'pending' | 'rejected' | 'changes' | 'outreach';

const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl shadow-lg';
const btn =
  'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5';
const toolBtn =
  'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default';

/**
 * The source filter is ONE select: everything, one kind of import, or one
 * particular sheet or file. Encoded in its value so the select stays native.
 */
const KIND_PREFIX = 'kind:';
function parseFilter(value: string): { source: 'all' | ImportKind; sourceId?: string } {
  if (!value) return { source: 'all' };
  if (value.startsWith(KIND_PREFIX)) return { source: value.slice(KIND_PREFIX.length) as ImportKind };
  return { source: 'all', sourceId: value };
}

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

/** A feature switched off on this server answers 404 to its list; that is "none", not an error. */
const unlessOff = (e: unknown): null => {
  if (isSheetsDisabled(e)) return null;
  throw e;
};

/**
 * Leads imported from Google Sheets or uploaded files, waiting for the owner.
 * One queue for both; every row says where it came from. Nothing here contacts
 * anyone: approving makes a lead eligible for the outreach strategy, which
 * picks it up on its own schedule and re-checks its own rules.
 *
 * Each import has its own server switch (GOOGLE_SHEETS_ENABLED,
 * FILE_IMPORT_ENABLED); the screen shows the controls of the ones that are on.
 *
 * No background polling: the list reloads when an import adds leads (the live
 * stream's lead.created), after every decision, after an upload, and after
 * "Sync now".
 */
export const ImportReviewView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('pending');
  const [sources, setSources] = useState<SheetSource[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [features, setFeatures] = useState({ sheets: true, files: true, hubspot: false });
  /** The connected HubSpot account's import source, when there is one: it changes after review, like a sheet. */
  const [crm, setCrm] = useState<{ id: string; name: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ pending?: number; rejected?: number }>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'more' | 'approve' | 'reject' | 'apply' | 'keep'>(null);
  const [armed, setArmed] = useState<null | 'approve' | 'reject' | 'apply' | 'keep'>(null);
  const [upload, setUpload] = useState(false);
  const [history, setHistory] = useState(false);
  /** Outreach scheduling (OUTREACH_SCHEDULING_ENABLED): null when the server has it off, and approving works as before. */
  const [outreach, setOutreach] = useState<OutreachConfig | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [outreachKey, setOutreachKey] = useState(0);

  const { source, sourceId } = useMemo(() => parseFilter(filter), [filter]);
  // "Changed since review" is about one source that keeps syncing — a sheet or
  // the HubSpot account: the chosen one, or the only one.
  const sheetIds = useMemo(() => new Set(sources.map((s) => s.id)), [sources]);
  const changeIds = useMemo(() => [...sources.map((s) => s.id), ...(crm ? [crm.id] : [])], [sources, crm]);
  const changeSource =
    tab === 'changes' ? (sourceId && changeIds.includes(sourceId) ? sourceId : changeIds.length === 1 ? changeIds[0] : '') : '';
  const crmChanges = Boolean(crm && changeSource === crm.id);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sheets, hist, hubspot, launch] = await Promise.all([
        listSheetSources().catch(unlessOff),
        importHistory().catch(unlessOff),
        getCrmStatus('hubspot').catch(unlessOff),
        getOutreachConfig(),
      ]);
      setOutreach(launch);
      setFeatures({ sheets: sheets !== null, files: hist !== null, hubspot: hubspot !== null });
      const list = sheets ?? [];
      setSources(list);
      const crmSource = hubspot?.sourceId ? { id: hubspot.sourceId, name: `HubSpot · ${hubspot.account?.name ?? hubspot.account?.id ?? 'account'}` } : null;
      setCrm(crmSource);
      setBatches((hist ?? []).filter((b) => b.kind === 'file_upload'));
      if (tab === 'pending' || tab === 'rejected') {
        const page = await reviewQueue({ state: tab, source, sourceId, limit: 50 });
        setItems(page.items);
        setCursor(page.nextCursor);
        setTotals((t) => ({ ...t, [tab]: page.total }));
        // Clean rows start ticked, so one click approves them; the owner unticks what should wait.
        setSelected(new Set(tab === 'pending' ? page.items.filter(clean).map((i) => i.rowId) : []));
      } else if (tab === 'changes') {
        const ids = [...list.map((s) => s.id), ...(crmSource ? [crmSource.id] : [])];
        const src = sourceId && ids.includes(sourceId) ? sourceId : ids.length === 1 ? ids[0] : '';
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
  }, [tab, source, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveEvents(
    useCallback(
      (e) => {
        if (
          e.type === 'lead.created' &&
          (sources.some((s) => s.id === e.leadSourceId) || batches.some((b) => b.id === e.leadSourceId) || crm?.id === e.leadSourceId)
        ) {
          void load();
        }
      },
      [sources, batches, crm, load],
    ),
  );

  const switchTab = (t: Tab) => {
    setTab(t);
    setItems([]);
    setCursor(null);
    setSelected(new Set());
    setArmed(null);
  };

  const more = async () => {
    if (!cursor) return;
    setBusy('more');
    try {
      const page = await reviewQueue({ state: tab === 'rejected' ? 'rejected' : 'pending', source, sourceId, cursor, limit: 50 });
      setItems((xs) => [...xs, ...page.items]);
      if (tab === 'pending') setSelected((s) => new Set([...s, ...page.items.filter(clean).map((i) => i.rowId)]));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Only a switched-on sheet can sync (the API refuses a paused one); a file never does.
  const syncTargets = useMemo(
    () =>
      source === 'file_upload' || source === 'hubspot' || (sourceId && !sheetIds.has(sourceId))
        ? []
        : sources.filter((s) => s.status === 'ACTIVE' && (!sourceId || s.id === sourceId)),
    [sources, source, sourceId, sheetIds],
  );
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
    try {
      await Promise.all(ids.map((id) => syncSheetSource(id)));
      let list = await listSheetSources();
      const running = () => list.some((s) => ids.includes(s.id) && (s.syncing || s.syncQueued));
      for (let i = 0; i < 120 && alive.current && running(); i++) {
        await new Promise((r) => setTimeout(r, 1_000));
        list = await listSheetSources();
      }
      const failed = list.filter((s) => ids.includes(s.id) && s.lastFailureAt && s.lastFailureAt !== failedBefore.get(s.id));
      if (failed.length > 0) toast.error(failed.map((s) => `${s.name}: ${s.lastErrorMessage ?? s.lastErrorCode}`).join(' '));
      else if (running()) toast.info('Still syncing — refresh in a moment to see the rest.');
      else toast.success(`Synced ${ids.length === 1 ? 'the sheet' : `${ids.length} sheets`} with Google.`);
      await load();
    } catch (e) {
      toast.error(errorText(e));
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

  /**
   * Two clicks for every decision: the first arms, the second acts. With
   * outreach scheduling on, approving opens the launch dialog instead.
   */
  const decide = async (what: 'approve' | 'reject' | 'apply' | 'keep', choice?: OutreachChoice) => {
    if (what === 'approve' && outreach && !choice) {
      setLaunchError(null);
      setLaunching(true);
      return;
    }
    if (!choice && armed !== what) {
      setArmed(what);
      return;
    }
    setArmed(null);
    setBusy(what);
    const ids = [...selected];
    try {
      if (what === 'approve') {
        const rs = await inBatches(ids, (batch) => approveRows(batch, choice));
        const merged = rs.reduce((a, r) => ({
          approved: a.approved + r.approved,
          released: a.released + r.released,
          held: [...a.held, ...r.held],
          skipped: [...a.skipped, ...r.skipped],
        }));
        toast.success(approveMessage(merged));
        setLaunching(false);
        setOutreachKey((k) => k + 1);
      } else if (what === 'reject') {
        const rs = await inBatches(ids, rejectRows);
        toast.success(
          rejectMessage(
            rs.reduce((a, r) => ({
              rejected: a.rejected + r.rejected,
              skipped: [...a.skipped, ...r.skipped],
            })),
          ),
        );
      } else {
        const rs = await inBatches(ids, (b) => resolveChanges(b, what));
        const n = rs.reduce((a, r) => a + r.resolved, 0);
        toast.success(
          what === 'apply'
            ? `Updated ${n} lead${n === 1 ? '' : 's'} with ${crmChanges ? 'HubSpot’s' : 'the sheet’s'} values.`
            : `Kept ${n} lead${n === 1 ? '' : 's'} as reviewed. ${crmChanges ? 'HubSpot’s' : 'The sheet’s'} change will not be raised again.`,
        );
      }
      setSelected(new Set());
      // Approved leads join the Leads list: tell the shell, so its count follows.
      if (what === 'approve') window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      await load();
    } catch (e) {
      // In the launch dialog a refused schedule (a time already past) is shown where it was picked.
      if (choice) setLaunchError(errorText(e));
      else toast.error(errorText(e));
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
            Leads from your{' '}
            {[features.sheets && 'Google Sheets', features.files && 'uploaded files', features.hubspot && 'HubSpot']
              .filter(Boolean)
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1') || 'imports'}{' '}
            wait here. Rows with a phone and no warning come already ticked, so one click approves them. Nobody is called or texted until you approve them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={tab === 'changes' ? changeSource : filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelected(new Set());
            }}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100 max-w-[16rem]"
            aria-label="Which imports to show"
          >
            {tab === 'changes' ? (
              <option value="">{crm ? 'Choose a source…' : 'Choose a sheet…'}</option>
            ) : (
              <>
                <option value="">All sources</option>
                {features.sheets && <option value={`${KIND_PREFIX}google_sheets`}>All Google Sheets</option>}
                {features.files && <option value={`${KIND_PREFIX}file_upload`}>All file uploads</option>}
                {features.hubspot && <option value={`${KIND_PREFIX}hubspot`}>All HubSpot</option>}
              </>
            )}
            {tab === 'changes' && crm && (
              <optgroup label="HubSpot">
                <option value={crm.id}>{crm.name}</option>
              </optgroup>
            )}
            {sources.length > 0 && (
              <optgroup label="Google Sheets">
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
            {tab !== 'changes' && batches.length > 0 && (
              <optgroup label="File uploads">
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {new Date(b.completedAt ?? b.createdAt).toLocaleDateString()}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {features.files && (
            <button type="button" onClick={() => setUpload(true)} className={toolBtn} title="Import leads from a CSV or Excel file">
              <FileUp className="w-3.5 h-3.5" />
              Upload a file
            </button>
          )}
          {features.files && (
            <button type="button" onClick={() => setHistory(true)} className={toolBtn} title="Every import so far, and where its rows stand">
              <History className="w-3.5 h-3.5" />
              History
            </button>
          )}
          {features.sheets && (
            <button
              type="button"
              onClick={() => void sync()}
              disabled={syncing || syncTargets.length === 0}
              title={
                syncTargets.length === 0
                  ? source === 'file_upload' || (sourceId && !sheetIds.has(sourceId))
                    ? 'An uploaded file is imported once; there is nothing to sync.'
                    : 'No sheet here is switched on. Switch one on in Integrations to sync it.'
                  : `Read ${sourceId ? 'this sheet' : 'every switched-on sheet'} from Google now`
              }
              className={toolBtn}
            >
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
      </div>

      <div className={`${card} p-4 space-y-3`}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
          {(
            [
              ['pending', `Waiting for review${totals.pending !== undefined ? ` (${totals.pending})` : ''}`],
              // Only a sheet or a CRM changes after review; an uploaded file is read once.
              ...(features.sheets || features.hubspot
                ? ([['changes', features.hubspot ? 'Changed since review' : 'Changed in the sheet']] as const)
                : []),
              ['rejected', `Rejected${totals.rejected !== undefined ? ` (${totals.rejected})` : ''}`],
              ...(outreach ? ([['outreach', 'Outreach']] as const) : []),
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
              {selected.size > 0 && (
                <button type="button" className={`${btn} text-slate-400 hover:text-white`} disabled={busy !== null} onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              )}
              {decisionButton('reject', 'Reject', 'bg-slate-800 text-slate-200 hover:bg-rose-600/30')}
              {decisionButton('approve', 'Approve', 'bg-green-600 text-white hover:bg-green-500')}
            </>
          ) : tab === 'rejected' || tab === 'outreach' ? null : (
            <>
              {decisionButton('keep', 'Keep current', 'bg-slate-800 text-slate-200 hover:bg-slate-700')}
              {decisionButton('apply', crmChanges ? 'Apply HubSpot values' : 'Apply sheet values', 'bg-green-600 text-white hover:bg-green-500')}
            </>
          )}
        </div>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => void load()} className="font-bold underline cursor-pointer">
              Retry
            </button>
          </div>
        )}

        {tab === 'outreach' && <OutreachBatches refreshKey={outreachKey} />}

        {loading && tab !== 'outreach' && (tab === 'changes' ? changes.length === 0 : items.length === 0) && (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {/* Waiting for review, and rejected (read-only) */}
        {(tab === 'pending' || tab === 'rejected') && !loading && items.length === 0 && !error && (
          <div className="text-center py-10 space-y-2">
            <Inbox className="w-7 h-7 text-slate-600 mx-auto" />
            <div className="text-xs text-slate-400">
              {tab === 'pending' ? 'No imported leads are waiting for review.' : 'No imported leads have been rejected.'}
            </div>
            {tab === 'pending' && features.files && sources.length === 0 && batches.length === 0 && (
              <button type="button" onClick={() => setUpload(true)} className="text-xs font-bold text-green-300 hover:text-green-200 cursor-pointer">
                Upload a CSV or Excel file to get started
              </button>
            )}
          </div>
        )}
        {(tab === 'pending' || tab === 'rejected') && items.length > 0 && (
          <div>
            {/* No horizontal scroll: short columns never wrap, long text truncates (full value on hover),
                and the source is an icon whose hover names the file or sheet and the row. */}
            {/* Fixed layout: the icon columns have a set width that fits their headings, Email gets
                a larger share, and the other text columns split what is left equally. Long values
                truncate, with the full text on hover. */}
            <table className="w-full table-fixed text-xs">
              <thead className="text-2xs uppercase text-slate-500 text-left">
                <tr>
                  {tab === 'pending' && (
                    <th className="px-2 py-2 w-10">
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
                  <th className="px-2 py-2 w-[30%]">Email</th>
                  <th className="px-2 py-2">Location</th>
                  <th className="px-2 py-2">Budget</th>
                  <th className="px-2 py-2 w-20 text-center">Source</th>
                  <th className="px-2 py-2 w-24 text-center">{tab === 'pending' ? 'Warnings' : 'Rejected'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {items.map((i) => {
                  // Our checks on the row (a bad email, a possible duplicate) — not the file's own notes column.
                  const warnings = (i.lead?.reviewReasons ?? []).filter((r) => !IMPORT_REASONS.includes(r));
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
                      <td className="px-2 py-2 text-slate-100">
                        <span className="block truncate" title={[i.lead?.firstName, i.lead?.lastName].filter(Boolean).join(' ')}>
                          {[i.lead?.firstName, i.lead?.lastName].filter(Boolean).join(' ') || '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-slate-300">
                        <span className="block truncate" title={i.lead?.phone ?? undefined}>
                          {i.lead?.phone ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-slate-300">
                        <span className="block truncate" title={i.lead?.email ?? undefined}>
                          {i.lead?.email ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-slate-400">
                        <span className="block truncate" title={i.lead?.location ?? undefined}>
                          {i.lead?.location ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-slate-400">
                        <span className="block truncate">{budget(i.lead?.minBudget ?? null, i.lead?.maxBudget ?? null)}</span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <SourceBadge
                          kind={i.source?.kind ?? 'google_sheets'}
                          label={false}
                          title={`${KIND_NAME[i.source?.kind ?? 'google_sheets']}: ${i.source?.name ?? '—'}${i.source?.kind === 'hubspot' ? '' : ` · row ${i.rowNumber}`}`}
                        />
                      </td>
                      {tab === 'rejected' ? (
                        <td className="px-2 py-2 text-slate-500 whitespace-nowrap text-center">
                          {i.reviewedAt ? new Date(i.reviewedAt).toLocaleDateString() : '—'}
                        </td>
                      ) : (
                        <td className="px-2 py-2">
                          {/* Icons only; what each means is on hover, like the source. */}
                          <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                            {i.lead?.dncStatus && (
                              <span
                                className="p-1 rounded border bg-rose-500/15 text-rose-300 border-rose-500/30 inline-flex cursor-help"
                                title="Do not contact — this contact opted out before"
                                aria-label="Do not contact"
                              >
                                <Ban className="w-3 h-3" />
                              </span>
                            )}
                            {i.missing && (
                              <span
                                className="p-1 rounded border bg-slate-800 text-slate-400 border-slate-700 inline-flex cursor-help"
                                title={
                                  i.source?.kind === 'hubspot'
                                    ? 'Deleted, archived or merged in HubSpot — the lead is kept; reject it if it should not be worked'
                                    : 'Removed from the sheet — the lead is kept; reject it if it should not be worked'
                                }
                                aria-label={i.source?.kind === 'hubspot' ? 'No longer in HubSpot' : 'Removed from the sheet'}
                              >
                                <FileX className="w-3 h-3" />
                              </span>
                            )}
                            {i.lead && !i.lead.phone && (
                              <span
                                className="p-1 rounded border bg-slate-800 text-slate-400 border-slate-700 inline-flex cursor-help"
                                title="No phone — approving keeps this lead paused, so it will not be called"
                                aria-label="No phone"
                              >
                                <PhoneOff className="w-3 h-3" />
                              </span>
                            )}
                            {warnings.length > 0 && (
                              <span
                                className="p-1 rounded border bg-amber-500/15 text-amber-300 border-amber-500/30 inline-flex cursor-help"
                                title={warnings.join('\n')}
                                aria-label={`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
                              >
                                <AlertTriangle className="w-3 h-3" />
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
          <div className="text-center py-10 text-xs text-slate-400">
            {crm ? 'Choose a source to see leads that changed there after you reviewed them.' : 'Choose a sheet to see rows that changed after you reviewed them.'}
          </div>
        )}
        {tab === 'changes' && changeSource && !loading && changes.length === 0 && !error && (
          <div className="text-center py-10 space-y-2">
            <Inbox className="w-7 h-7 text-slate-600 mx-auto" />
            <div className="text-xs text-slate-400">
              {crmChanges ? 'No reviewed leads have a HubSpot change waiting for you.' : 'No reviewed rows have changed in the sheet.'}
            </div>
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
                    {crmChanges ? '' : `row ${c.rowNumber} · `}
                    {c.reviewState} · changed {new Date(c.changedAt).toLocaleString()}
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
                      <th className="py-1 font-semibold">{crmChanges ? 'In HubSpot' : 'In the sheet'}</th>
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

      {launching && outreach && (
        <ApproveOutreachModal
          count={selected.size}
          flaggedLeftOut={items.filter((i) => !clean(i) && !selected.has(i.rowId)).length}
          config={outreach}
          busy={busy === 'approve'}
          error={launchError}
          onClose={() => setLaunching(false)}
          onConfirm={(choice) => void decide('approve', choice)}
        />
      )}
      {upload && (
        <FileImportModal
          onClose={() => setUpload(false)}
          onImported={(b) => {
            toast.success(`${b.rows?.imported ?? 0} lead${b.rows?.imported === 1 ? '' : 's'} from ${b.name} added for review.`);
            void load();
          }}
        />
      )}
      {history && (
        <ImportHistoryModal
          onClose={() => setHistory(false)}
          onReview={(b) => {
            setHistory(false);
            switchTab('pending');
            setFilter(b.id);
          }}
          onChanged={() => {
            // A removed upload may be the one the filter names: back to everything.
            setFilter((f) => (batches.some((b) => b.id === f) ? '' : f));
            void load();
          }}
        />
      )}
    </div>
  );
};

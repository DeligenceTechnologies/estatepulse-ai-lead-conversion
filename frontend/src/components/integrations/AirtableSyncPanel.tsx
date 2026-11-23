import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, RefreshCw, RotateCw, Trash2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  createAirtableField,
  DIRECTION_LABELS,
  listAirtableTableFields,
  listAirtableWriteBackFields,
  SCOPE_LABELS,
  getAirtableStatus,
  removeAirtableSource,
  retryAirtableFailed,
  setAirtableSync,
  syncAirtableNow,
  type AirtableSyncStatus,
  type AirtableFieldSummary,
  type AirtableWriteBack,
  type AirtableWriteBackField,
  type ExportScope,
  type SyncDirection,
} from '../../utils/airtableApi';
import { errorText, timeAgo } from '../sheets/SheetModal';

/**
 * One synced Airtable table: how it syncs, how it is doing, and the two things
 * an owner needs when it is not — sync now, and retry what failed.
 *
 * A failed write is never dropped silently; it is listed here with its reason
 * until it succeeds or someone retries it.
 */

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-xs text-slate-500 shrink-0">{label}</span>
    <span className="text-xs text-slate-200 truncate text-right">{value}</span>
  </div>
);

const DIRECTIONS: SyncDirection[] = ['import', 'export', 'two_way'];
const SCOPES: ExportScope[] = ['this_table', 'all_leads'];

export const AirtableSyncPanel: React.FC<{ sourceId: string; onClose: () => void; onChanged: () => void }> = ({ sourceId, onClose, onChanged }) => {
  const [status, setStatus] = useState<AirtableSyncStatus | null>(null);
  const [busy, setBusy] = useState<null | 'sync' | 'retry' | 'save' | 'remove'>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [confirmDirection, setConfirmDirection] = useState<SyncDirection | null>(null);
  const [catalogue, setCatalogue] = useState<AirtableWriteBackField[]>([]);
  const [columns, setColumns] = useState<AirtableFieldSummary[]>([]);
  const [making, setMaking] = useState<string | null>(null);
  // The one report whose column the owner is picking by hand, if any.
  const [changing, setChanging] = useState<string | null>(null);

  // Escape closes it, and the page behind stays put while it is open — the same
  // two things every other dialog here does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const load = useCallback(async () => {
    try {
      setStatus(await getAirtableStatus(sourceId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const writes = status ? status.direction !== 'import' : false;
  useEffect(() => {
    if (!writes || catalogue.length) return;
    void Promise.all([listAirtableWriteBackFields(), listAirtableTableFields(sourceId)])
      .then(([c, f]) => {
        setCatalogue(c);
        setColumns(f);
      })
      .catch(() => undefined);
  }, [writes, catalogue.length, sourceId]);

  /** Save one choice: a column id, or null to stop reporting that field. */
  const chooseWriteBack = async (key: string, fieldId: string | null) => {
    if (!status) return;
    const next: AirtableWriteBack[] = [...status.writeBack.filter((w) => w.key !== key), ...(fieldId ? [{ key, fieldId }] : [])];
    setBusy('save');
    try {
      await setAirtableSync(sourceId, status.direction, status.exportScope, next);
      // Only this panel is reloaded. onChanged() rebuilds the whole card —
      // config, connections and every source — and none of that shows which
      // reports are switched on, so a toggle would pay for three requests that
      // change nothing on screen.
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Make the column in Airtable and point the field at it, in one go. The owner
   * should not have to go and build a column by hand, guess its type, and come
   * back to map it.
   */
  /**
   * Start sending one report. There is nothing to choose in the normal case:
   * a table has no column called "Buying intent" until EstatePulse makes one,
   * and a column of the same name from a previous setup is simply reused.
   */
  const sendToAirtable = async (f: AirtableWriteBackField) => {
    const same = columns.find((c) => !c.readOnly && c.name.trim().toLowerCase() === f.label.trim().toLowerCase());
    if (same) return chooseWriteBack(f.key, same.id);
    return createFor(f);
  };

  /**
   * Make the column and start the report in ONE request, then fold the answer
   * into what is already on screen.
   *
   * Every extra round trip here is paid in front of somebody waiting, and the
   * server comes back with the whole truth — the new column, the table's
   * columns, and the reports now switched on — so there is nothing left to go
   * and ask for.
   */
  const createFor = async (f: AirtableWriteBackField) => {
    setMaking(f.key);
    try {
      const { field, fields, writeBack } = await createAirtableField(sourceId, {
        name: f.label,
        type: f.type,
        choices: f.choices,
        sendAs: f.key,
      });
      setColumns(fields);
      setStatus((s) => (s ? { ...s, writeBack } : s));
      onChanged();
      toast.success(`Added "${field.name}" to Airtable.`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setMaking(null);
    }
  };

  const save = async (direction: SyncDirection, exportScope: ExportScope) => {
    setBusy('save');
    try {
      await setAirtableSync(sourceId, direction, exportScope);
      await load();
      onChanged();
      toast.success('Sync settings saved.');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const act = async (what: 'sync' | 'retry') => {
    setBusy(what);
    try {
      if (what === 'sync') {
        await syncAirtableNow(sourceId);
        toast.success('Sync queued.');
      } else {
        const { retrying } = await retryAirtableFailed(sourceId);
        toast.success(retrying ? `Retrying ${retrying} record${retrying === 1 ? '' : 's'}.` : 'Nothing was waiting to retry.');
      }
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy('remove');
    try {
      await removeAirtableSource(sourceId);
      toast.success('Stopped syncing that table. Imported leads were kept.');
      onChanged();
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const button = 'px-3 py-1.5 rounded-lg text-2xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-default';

  // Into document.body, like every other dialog in the app; see the note in
  // AirtableSetupModal for what goes wrong when a panel is left inside a card.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="airtable-sync-title"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-800">
          <div className="min-w-0">
            <h2 id="airtable-sync-title" className="text-base font-bold text-white truncate">
              {status?.source.name ?? 'Airtable table'}
            </h2>
            <p className="text-xs text-slate-400">Sync settings and status</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
              <div className="text-xs text-rose-200 leading-relaxed">{error}</div>
            </div>
          )}
          {!status && !error && (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}

          {status && (
            <>
              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 space-y-2">
                <Fact label="Base / table" value={`${status.source.baseId} · ${status.source.tableId}`} />
                <Fact
                  label="Change detection"
                  value={status.watching ? 'Watching for changes' : 'Re-reads the table on a schedule'}
                />
                <Fact label="Last successful sync" value={status.lastSuccessfulSyncAt ? timeAgo(status.lastSuccessfulSyncAt) : 'Never'} />
                <Fact label="Next scheduled sync" value={status.nextSyncAt ? timeAgo(status.nextSyncAt) : '—'} />
                {status.lastWebhookAt && <Fact label="Last change from Airtable" value={timeAgo(status.lastWebhookAt)} />}
                {status.syncing && <Fact label="Now" value={<span className="text-sky-300">Syncing…</span>} />}
                {status.lastError && (
                  <Fact label="Last error" value={<span className="text-rose-300">{status.lastError.message ?? status.lastError.code}</span>} />
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Leads imported', status.counts.importedLeads],
                  ['Records written', status.counts.exported],
                  ['Waiting in review', status.counts.pendingReview],
                  ['Conflicts to review', status.counts.changesToReview],
                  ['Failed writes', status.counts.failed],
                ].map(([label, n]) => (
                  <div key={String(label)} className="bg-slate-950 border border-slate-800/80 rounded-xl p-3">
                    <div className="text-base font-bold text-white">{n}</div>
                    <div className="text-2xs text-slate-500">{label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-bold text-slate-300">Which way does this sync?</h3>
                {DIRECTIONS.map((d) => (
                  <label key={d} className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="direction"
                      checked={status.direction === d}
                      onChange={() => {
                        // Turning on a direction that writes is the moment
                        // EstatePulse starts changing records in somebody's own
                        // Airtable base. That earns a deliberate yes, the way
                        // "Stop syncing" already does.
                        if (d !== 'import' && status.direction === 'import') setConfirmDirection(d);
                        else void save(d, status.exportScope);
                      }}
                      disabled={busy !== null}
                      className="mt-0.5 cursor-pointer"
                    />
                    <span className="min-w-0">
                      <span className="text-xs text-slate-200 block">{DIRECTION_LABELS[d].label}</span>
                      <span className="text-2xs text-slate-500 leading-relaxed">{DIRECTION_LABELS[d].help}</span>
                    </span>
                  </label>
                ))}

                {confirmDirection && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-2">
                    <p className="text-2xs text-amber-200 leading-relaxed">
                      EstatePulse will start creating and updating records in your Airtable base. Nothing is deleted, and columns
                      EstatePulse does not know about are left exactly as they are.
                    </p>
                    <div className="flex justify-end gap-3">
                      <button
                        type="button"
                        className="text-2xs font-bold text-slate-400 hover:text-white cursor-pointer"
                        onClick={() => setConfirmDirection(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="text-2xs font-bold text-amber-300 hover:text-amber-200 cursor-pointer"
                        onClick={() => {
                          const next = confirmDirection;
                          setConfirmDirection(null);
                          void save(next, status.exportScope);
                        }}
                      >
                        Yes, write to Airtable
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Only meaningful when something is written out at all. */}
              {status.direction !== 'import' && (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-300">Which leads go to Airtable?</h3>
                  {SCOPES.map((sc) => (
                    <label key={sc} className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="scope"
                        checked={status.exportScope === sc}
                        onChange={() => void save(status.direction, sc)}
                        disabled={busy !== null}
                        className="mt-0.5 cursor-pointer"
                      />
                      <span className="min-w-0">
                        <span className="text-xs text-slate-200 block">{SCOPE_LABELS[sc].label}</span>
                        <span className="text-2xs text-slate-500 leading-relaxed">{SCOPE_LABELS[sc].help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {status.direction !== 'import' && catalogue.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-300">What should EstatePulse report back?</h3>
                  <p className="text-2xs text-slate-500 leading-relaxed">
                    These are written to Airtable and never read from it — a score or a call outcome is something EstatePulse works out.
                    EstatePulse adds a column of the right type for each one you switch on. Nothing else in your base is touched.
                  </p>
                  {[...new Set(catalogue.map((f) => f.group))].map((group) => (
                    <div key={group} className="space-y-1.5">
                      <div className="text-2xs font-bold text-slate-500 pt-1">{group}</div>
                      {catalogue
                        .filter((f) => f.group === group)
                        .map((f) => {
                          const chosen = status.writeBack.find((w) => w.key === f.key);
                          const column = chosen ? columns.find((c) => c.id === chosen.fieldId) : undefined;
                          // Only the columns that could hold this, for the rare
                          // owner who wants a particular one. A score offered a
                          // Name column is not a choice anybody should be asked
                          // to make.
                          const fits = columns.filter((c) => !c.readOnly && (!f.kind || !c.kind || c.kind === f.kind));
                          const working = busy !== null || making !== null;
                          return (
                            <div key={f.key} className="bg-slate-950 border border-slate-800/80 rounded-xl p-2.5 flex items-center gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-xs text-slate-200 truncate">{f.label}</div>
                                <div className="text-2xs text-slate-500 leading-relaxed">{f.help}</div>
                              </div>

                              {/* Picking a column is the rare case, so it is not
                                  what the row opens with. These are EstatePulse's
                                  own outputs: an owner's table has no column for
                                  "buying intent", and pointing one at their Notes
                                  would have us overwrite their notes. */}
                              {changing === f.key ? (
                                <>
                                  <select
                                    aria-label={`Airtable column for ${f.label}`}
                                    value={chosen?.fieldId ?? ''}
                                    onChange={(e) => {
                                      setChanging(null);
                                      void chooseWriteBack(f.key, e.target.value || null);
                                    }}
                                    disabled={working}
                                    className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5 cursor-pointer min-w-[11rem] shrink-0"
                                  >
                                    <option value="">Don’t send</option>
                                    {fits.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.name}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    className="text-2xs font-bold text-slate-400 hover:text-white cursor-pointer shrink-0"
                                    onClick={() => setChanging(null)}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : chosen ? (
                                <>
                                  <span className="text-2xs text-emerald-300 shrink-0 truncate max-w-[10rem]" title={column?.name}>
                                    → {column?.name ?? 'column'}
                                  </span>
                                  <button
                                    type="button"
                                    className="text-2xs font-bold text-slate-500 hover:text-white cursor-pointer shrink-0"
                                    onClick={() => setChanging(f.key)}
                                    disabled={working}
                                  >
                                    Change
                                  </button>
                                  <button
                                    type="button"
                                    className="text-2xs font-bold text-slate-500 hover:text-rose-300 cursor-pointer shrink-0"
                                    onClick={() => void chooseWriteBack(f.key, null)}
                                    disabled={working}
                                  >
                                    Stop
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="text-2xs font-bold text-sky-400 hover:text-sky-300 cursor-pointer disabled:opacity-40 shrink-0"
                                  onClick={() => void sendToAirtable(f)}
                                  disabled={working || !status.permissions?.writeSchema}
                                  title={status.permissions?.writeSchema ? undefined : 'This connection cannot add columns to Airtable.'}
                                >
                                  {making === f.key ? 'Adding…' : 'Send to Airtable'}
                                </button>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  ))}
                </div>
              )}

              {status.permissions && !status.permissions.writeSchema && (
                <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 text-2xs text-slate-400 leading-relaxed">
                  This connection cannot add columns to Airtable. Record sync is unaffected — to add columns, reconnect Airtable and approve the
                  schema permission.
                </div>
              )}

              {status.failures.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-bold text-slate-300">Writes that failed</h3>
                  {status.failures.map((f) => (
                    <div key={f.rowId} className="bg-slate-950 border border-rose-500/20 rounded-xl p-2.5">
                      <div className="text-2xs text-rose-200 truncate">{f.message ?? f.code}</div>
                      <div className="text-2xs text-slate-500">
                        {f.attempts} attempt{f.attempts === 1 ? '' : 's'}
                        {f.nextAttemptAt ? ` · next ${timeAgo(f.nextAttemptAt)}` : ' · waiting for a manual retry'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t border-slate-800 flex items-center gap-2">
          <button type="button" className={`${button} bg-slate-800 text-slate-300 hover:bg-slate-700`} onClick={() => void act('sync')} disabled={busy !== null}>
            {busy === 'sync' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync now
          </button>
          <button
            type="button"
            className={`${button} bg-slate-800 text-slate-300 hover:bg-slate-700`}
            onClick={() => void act('retry')}
            disabled={busy !== null || !status?.counts.failed}
          >
            {busy === 'retry' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
            Retry failed
          </button>
          <button
            type="button"
            className={`${button} ml-auto ${armed ? 'bg-rose-600 text-white hover:bg-rose-500' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
            onClick={() => void remove()}
            disabled={busy !== null}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {armed ? 'Yes, stop syncing' : 'Stop syncing'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

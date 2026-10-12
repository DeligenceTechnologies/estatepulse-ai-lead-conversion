import React, { useEffect, useState } from 'react';
import { FileSpreadsheet, Loader2 } from 'lucide-react';
import {
  createSheetSource,
  inspectSpreadsheet,
  type SheetSource,
  type SpreadsheetInspection,
} from '../../utils/googleSheetsApi';
import { SheetError, SheetModal, errorText } from './SheetModal';

/**
 * Step two of adding a sheet: the owner picked a spreadsheet in Google's
 * picker; now they choose which tab holds the leads. The server reads the tabs
 * itself, which is also the proof that it can open the file.
 */
export const SheetTabPickerModal: React.FC<{
  connectionId: string;
  spreadsheetId: string;
  onClose: () => void;
  onCreated: (source: SheetSource) => void;
}> = ({ connectionId, spreadsheetId, onClose, onCreated }) => {
  const [sheet, setSheet] = useState<SpreadsheetInspection | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    inspectSpreadsheet(connectionId, spreadsheetId)
      .then((s) => {
        if (!live) return;
        setSheet(s);
        setTabId(s.tabs[0]?.sheetId ?? null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [connectionId, spreadsheetId]);

  const create = async () => {
    if (tabId === null) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createSheetSource({ connectionId, spreadsheetId, sheetId: tabId }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetModal
      title={sheet?.title ?? 'Reading the spreadsheet…'}
      subtitle="Which tab holds your leads?"
      icon={<FileSpreadsheet className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {!sheet && !error && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Opening it with your Google connection…
        </div>
      )}
      {error && <SheetError message={error} />}

      {sheet && (
        <div className="space-y-2">
          {sheet.tabs.length === 0 && <p className="text-xs text-slate-400">This spreadsheet has no tabs with cells.</p>}
          {sheet.tabs.map((t) => (
            <label
              key={t.sheetId}
              className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                tabId === t.sheetId ? 'border-green-500/50 bg-green-500/5' : 'border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <input type="radio" name="tab" checked={tabId === t.sheetId} onChange={() => setTabId(t.sheetId)} />
                <span className="text-xs text-slate-100 truncate">{t.title}</span>
              </span>
              {t.rowCount !== null && (
                <span className="text-2xs text-slate-500 shrink-0">
                  {t.rowCount.toLocaleString()} × {t.columnCount} grid
                </span>
              )}
            </label>
          ))}
          <p className="text-2xs text-slate-500">
            The first row must be the column headings. Nothing is imported until you map the columns and switch it on.
          </p>
          <button
            type="button"
            onClick={create}
            disabled={busy || tabId === null}
            className="w-full px-4 py-2 rounded-xl text-xs font-bold bg-green-600 text-white hover:bg-green-500 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center justify-center gap-1.5"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Use this tab
          </button>
        </div>
      )}
    </SheetModal>
  );
};

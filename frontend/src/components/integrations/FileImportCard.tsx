import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, FileUp } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  downloadTemplate,
  getFileImportLimits,
  importHistory,
  formatBytes,
  type FileImportLimits,
  type ImportBatch,
} from '../../utils/fileImportApi';
import { isSheetsDisabled } from '../../utils/googleSheetsApi';
import { FileImportModal } from '../imports/FileImportModal';
import { errorText, timeAgo } from '../sheets/SheetModal';
import { IntegrationCard } from './IntegrationCard';

/**
 * Import leads from a file — the hand-off for an org whose leads live in a
 * CSV or an Excel export. Uploaded leads wait in Import Review like a sheet's.
 */
export const FileImportCard: React.FC = () => {
  const { setActiveView } = useApp();
  const [limits, setLimits] = useState<FileImportLimits | null>(null);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, history] = await Promise.all([getFileImportLimits(), importHistory()]);
      setLimits(l);
      setBatches(history.filter((b) => b.kind === 'file_upload'));
      setError(null);
    } catch (e) {
      if (isSheetsDisabled(e)) setDisabled(true);
      else setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Switched off on this server (GOOGLE_SHEETS_ENABLED, shared with the sheets): no card at all.
  if (disabled) return null;

  const pending = batches.reduce((n, b) => n + b.review.pending, 0);
  const last = batches[0];

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-sky-600/20 text-sky-400 flex items-center justify-center border border-sky-500/30 shrink-0">
            <FileUp className="w-5 h-5" />
          </div>
        }
        title="Import from a file"
        blurb="Upload a CSV or Excel file of leads, reviewed before anyone is contacted"
        connected={batches.length > 0}
        loading={loading}
        accent="border-sky-500/40"
        action={{
          label: 'Upload a file',
          icon: <FileUp className="w-3.5 h-3.5" />,
          onClick: () => setOpen(true),
          className: 'bg-slate-800 text-slate-100 hover:bg-slate-700',
        }}
      >
        {!loading && limits && (
          <p className="text-xs text-slate-500">
            .csv or .xlsx, up to {formatBytes(limits.maxBytes)} and {limits.maxRows.toLocaleString('en-US')} rows. The first row holds the
            headings.
          </p>
        )}
        {last && (
          <div className="text-2xs text-slate-500">
            Last import {timeAgo(last.completedAt ?? last.createdAt)}: {last.name}
            {pending > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setActiveView('import_review')}
                  className="text-green-300 hover:text-green-200 font-bold cursor-pointer"
                >
                  {pending} waiting for review
                </button>
              </>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={downloadTemplate}
          className="text-2xs font-bold text-slate-400 hover:text-white cursor-pointer flex items-center gap-1"
        >
          <Download className="w-3 h-3" /> Download a sample CSV
        </button>
        {error && (
          <div className="flex items-start gap-1.5 text-xs text-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </IntegrationCard>

      {open && (
        <FileImportModal
          onClose={() => setOpen(false)}
          onImported={() => {
            void load();
          }}
        />
      )}
    </>
  );
};

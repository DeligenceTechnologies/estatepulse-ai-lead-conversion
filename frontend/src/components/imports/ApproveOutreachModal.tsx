import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { OutreachChoice, OutreachConfig } from '../../utils/outreachApi';
import { SheetError, SheetModal } from '../sheets/SheetModal';
import { OutreachPicker, initialLaunch, launchChoice, launchProblem } from './OutreachPicker';

/**
 * Approve, and choose how the approved leads launch: now, or at a time in a
 * chosen zone. Either way the server paces calls by the organization's limits
 * and holds everything inside its contact window.
 */
export const ApproveOutreachModal: React.FC<{
  count: number;
  /** Flagged rows on screen that are not selected: they stay in review. */
  flaggedLeftOut: number;
  config: OutreachConfig;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (choice: OutreachChoice) => void;
}> = ({ count, flaggedLeftOut, config, busy, error, onClose, onConfirm }) => {
  const [launch, setLaunch] = useState(() => initialLaunch(config));

  return (
    <SheetModal title={`Approve ${count} lead${count === 1 ? '' : 's'}`} subtitle="Choose when the AI agent starts reaching out." onClose={busy ? () => undefined : onClose}>
      <OutreachPicker config={config} value={launch} onChange={setLaunch} />

      <div className="text-2xs text-slate-400 space-y-0.5">
        <div>
          <span className="text-slate-200 font-semibold">{count}</span> selected to approve.
          {flaggedLeftOut > 0 && (
            <>
              {' '}
              <span className="text-amber-300 font-semibold">{flaggedLeftOut}</span> flagged row{flaggedLeftOut === 1 ? '' : 's'} not selected stay
              {flaggedLeftOut === 1 ? 's' : ''} in review.
            </>
          )}
        </div>
        <div>Leads that opted out, have no dialable phone or are already being worked are approved but not contacted.</div>
      </div>

      {error && <SheetError message={error} />}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 hover:text-white cursor-pointer disabled:opacity-40">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || launchProblem(launch) !== null}
          onClick={() => onConfirm(launchChoice(launch))}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white hover:bg-green-500 cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {launch.mode === 'now' ? 'Approve and call now' : 'Approve and schedule'}
        </button>
      </div>
    </SheetModal>
  );
};

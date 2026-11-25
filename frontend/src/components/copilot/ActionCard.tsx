import React from 'react';
import { ArrowRight, Check, CircleAlert, Clock, X } from 'lucide-react';
import { Button } from '../common/Button';
import type { CopilotAction } from '../../utils/copilotApi';

const STATUS: Record<Exclude<CopilotAction['status'], 'proposed'>, { label: string; className: string; icon: React.ReactElement }> = {
  executing: { label: 'Running…', className: 'text-slate-400', icon: <Clock className="w-3.5 h-3.5" /> },
  executed: { label: 'Done', className: 'text-emerald-400', icon: <Check className="w-3.5 h-3.5" /> },
  rejected: { label: 'Cancelled', className: 'text-slate-500', icon: <X className="w-3.5 h-3.5" /> },
  expired: { label: 'Expired', className: 'text-slate-500', icon: <Clock className="w-3.5 h-3.5" /> },
  failed: { label: 'Failed', className: 'text-rose-400', icon: <CircleAlert className="w-3.5 h-3.5" /> },
};

const isExpired = (a: CopilotAction) => a.status === 'proposed' && a.expiresAt !== null && new Date(a.expiresAt).getTime() < Date.now();

interface ActionCardProps {
  action: CopilotAction;
  disabled: boolean;
  onConfirm: () => void;
  onReject: () => void;
}

export const ActionCard: React.FC<ActionCardProps> = ({ action, disabled, onConfirm, onReject }) => {
  const open = action.status === 'proposed' && !isExpired(action);
  const state = open ? null : STATUS[action.status === 'proposed' ? 'expired' : action.status];

  return (
    <div className={`rounded-xl border p-3 space-y-2.5 ${open ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-slate-800 bg-slate-900/60'}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-slate-100">{action.title}</p>
        {state && (
          <span className={`inline-flex items-center gap-1 text-2xs font-semibold shrink-0 ${state.className}`}>
            {state.icon}
            {state.label}
          </span>
        )}
      </div>

      {action.changes.length > 0 && (
        <dl className="space-y-1">
          {action.changes.map((c) => (
            <div key={c.field} className="grid grid-cols-[minmax(72px,auto)_1fr] gap-2 text-2xs">
              <dt className="text-slate-500">{c.field}</dt>
              <dd className="flex flex-wrap items-center gap-1 min-w-0 text-slate-200">
                {c.from !== null && (
                  <>
                    <span className="line-through text-slate-500 break-all">{c.from}</span>
                    <ArrowRight className="w-3 h-3 text-slate-600 shrink-0" aria-hidden />
                  </>
                )}
                <span className="break-all">{c.to ?? <em className="text-slate-500">cleared</em>}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {action.summary && <p className="text-2xs text-slate-400">{action.summary}</p>}
      {action.status === 'failed' && action.error && <p className="text-2xs text-rose-300">{action.error}</p>}

      {open && (
        <div className="flex gap-2 pt-0.5">
          <Button size="sm" icon={<Check />} onClick={onConfirm} disabled={disabled}>
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject} disabled={disabled}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
};

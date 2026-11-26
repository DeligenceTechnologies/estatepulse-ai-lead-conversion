import React, { useState } from 'react';
import { ArrowRight, Check, CircleAlert, Clock, ShieldCheck, X } from 'lucide-react';
import { Button } from '../common/Button';
import type { AssistantAction } from '../../utils/assistantChatApi';
import { BulkProgressPanel, TYPED_CONFIRM_ABOVE } from './BulkProgress';

const DECIDED: Record<Exclude<AssistantAction['status'], 'proposed'>, { label: string; className: string; icon: React.ReactElement }> = {
  executing: { label: 'Running…', className: 'text-slate-400', icon: <Clock className="w-3.5 h-3.5" /> },
  executed: { label: 'Done', className: 'text-emerald-400', icon: <Check className="w-3.5 h-3.5" /> },
  rejected: { label: 'Cancelled', className: 'text-slate-500', icon: <X className="w-3.5 h-3.5" /> },
  expired: { label: 'Expired', className: 'text-slate-500', icon: <Clock className="w-3.5 h-3.5" /> },
  failed: { label: 'Failed', className: 'text-rose-400', icon: <CircleAlert className="w-3.5 h-3.5" /> },
};

/** Whole minutes left on an open card, at least 1; null once it has run out. */
export const minutesLeft = (expiresAt: string | null, now = Date.now()): number | null => {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  return ms <= 0 ? null : Math.max(1, Math.ceil(ms / 60_000));
};

interface ApprovalCardProps {
  action: AssistantAction;
  disabled: boolean;
  /** `count`: the number of leads typed to approve a bulk card above 10 leads. */
  onDecide: (decision: 'confirm' | 'reject', count?: number) => void;
}

/** A change the assistant wants to make. Nothing happens until the user clicks Approve. */
export const ApprovalCard: React.FC<ApprovalCardProps> = ({ action, disabled, onDecide }) => {
  const left = action.status === 'proposed' ? minutesLeft(action.expiresAt) : null;
  const open = action.status === 'proposed' && (action.expiresAt === null || left !== null);
  const decided = open ? null : DECIDED[action.status === 'proposed' ? 'expired' : action.status];
  // A bulk card above the threshold is approved only once the user types its number of leads.
  const total = action.bulk?.total ?? 0;
  const needsCount = open && total > TYPED_CONFIRM_ABOVE;
  const [typed, setTyped] = useState('');
  const countOk = !needsCount || Number(typed) === total;
  const running = !!action.bulk && action.status === 'executed';

  return (
    <div className={`rounded-2xl border overflow-hidden ${open ? 'border-emerald-500/40 bg-slate-950' : 'border-slate-800 bg-slate-900/60'}`}>
      {open && (
        <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-2xs uppercase font-bold tracking-wider">
          <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
          Approval needed
        </div>
      )}
      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <p className={`font-bold text-white ${open ? 'text-base' : 'text-sm'}`}>{action.title}</p>
          {decided && !running && (
            <span className={`inline-flex items-center gap-1 text-2xs font-semibold shrink-0 ${decided.className}`}>
              {decided.icon}
              {decided.label}
            </span>
          )}
        </div>

        {action.changes.length > 0 && (
          <dl className="space-y-1.5">
            {action.changes.map((c) => (
              <div key={c.field} className="flex gap-3 text-sm">
                <dt className="w-24 shrink-0 text-slate-500">{c.field}</dt>
                <dd className="flex flex-wrap items-center gap-1.5 min-w-0 text-slate-100">
                  {c.from !== null && (
                    <>
                      <span className="line-through text-slate-500 break-all">{c.from}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-slate-600 shrink-0" aria-hidden />
                    </>
                  )}
                  <span className="break-all">{c.to ?? <em className="text-slate-500">cleared</em>}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}

        {action.summary && <p className="text-xs text-slate-400">{action.summary}</p>}
        {action.status === 'failed' && action.error && <p className="text-xs text-rose-300">{action.error}</p>}
        {running && <BulkProgressPanel actionId={action.id} initialStatus={action.bulk!.status} total={total} />}
      </div>

      {open && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-800">
          {needsCount && (
            <input
              type="number"
              inputMode="numeric"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Type ${total}`}
              aria-label={`Type ${total} to approve this action on ${total} leads`}
              className="w-24 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
            />
          )}
          <Button size="sm" icon={<Check />} onClick={() => onDecide('confirm', needsCount ? total : undefined)} disabled={disabled || !countOk}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDecide('reject')} disabled={disabled}>
            Cancel
          </Button>
          {left !== null && <span className="ml-auto text-2xs text-slate-500">{`Expires in ${left} min`}</span>}
        </div>
      )}
    </div>
  );
};

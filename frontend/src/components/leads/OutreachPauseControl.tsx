import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Pause, Play } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { messageFor } from '../../lib/api';
import {
  getOutreachPlan,
  pauseLeadOutreach,
  resumeLeadOutreach,
  type LeadOutreachState,
  type OutreachPlan,
} from '../../utils/assistantApi';
import { Button } from '../common/Button';

interface Props {
  leadId: string;
  /** The lead's pause state, as the modal last read it; null while loading. */
  state: LeadOutreachState | null;
  /** Called once the server has paused or resumed, so the modal reloads the flow and the state. */
  onChanged: () => void;
}

/**
 * "Pause outreach" / "Resume outreach" on the lead's page. An agent sees it on their own leads and
 * an admin on any lead; the server decides (`canControl`) and enforces the same rule.
 *
 * Opening it asks the server what would change, so the person confirms the real effect: which
 * steps and sequences pause, or what restarts and what was lost during the pause.
 */
export const OutreachPauseControl: React.FC<Props> = ({ leadId, state, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<OutreachPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const action = state?.paused ? 'resume' : 'pause';

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPlan(null);
    setError(null);
    setReason('');
    getOutreachPlan(leadId, action)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setError(messageFor(e)));
    return () => {
      alive = false;
    };
  }, [open, leadId, action]);

  // Close on an outside click or Escape, like the app's other popovers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!state?.canControl) return null;
  // Only a button that would do something: nothing to pause (booked, closed, strategy over) or nothing to restart shows why instead.
  const offered = state.paused ? state.canResume !== false : state.canPause !== false;
  if (!offered) return <OutreachIdleNote note={state.note ?? null} />;

  const confirm = async (): Promise<void> => {
    setSaving(true);
    try {
      if (action === 'pause') await pauseLeadOutreach(leadId, reason.trim() || undefined);
      else await resumeLeadOutreach(leadId);
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      toast.success(action === 'pause' ? 'Outreach paused.' : 'Outreach resumed.');
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        icon={action === 'pause' ? <Pause className="text-amber-400" /> : <Play className="text-emerald-400" />}
      >
        {action === 'pause' ? 'Pause outreach' : 'Resume outreach'}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label={action === 'pause' ? 'Pause outreach' : 'Resume outreach'}
          className="absolute left-0 lg:left-auto lg:right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] z-20 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-slate-800 text-2xs uppercase font-bold tracking-wide text-slate-500">
            {action === 'pause' ? 'This pauses' : 'This restarts'}
          </div>

          <div className="p-3 space-y-2.5 text-xs">
            {error ? (
              <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            ) : plan === null ? (
              <div className="text-slate-400 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
              </div>
            ) : (
              <>
                {plan.lines.length > 0 ? (
                  <ul className="space-y-1 list-disc pl-4 text-slate-100">
                    {plan.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-300">Nothing restarts right away.</p>
                )}
                {plan.notes.map((note) => (
                  <p key={note} className="text-slate-400 leading-relaxed">
                    {note}
                  </p>
                ))}
                {action === 'pause' && (
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={300}
                    placeholder="Reason (optional)"
                    aria-label="Reason for pausing"
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                )}
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void confirm()} loading={saving} disabled={plan === null || !!error}>
                {action === 'pause' ? 'Pause' : 'Resume'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** Shown in place of the button when pausing or resuming would change nothing. */
export const OutreachIdleNote: React.FC<{ note: string | null }> = ({ note }) =>
  note ? (
    <span className="self-center text-xs text-slate-500 max-w-[22rem] truncate" title={note}>
      {note}
    </span>
  ) : null;


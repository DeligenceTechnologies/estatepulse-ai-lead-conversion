import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, UserPlus } from 'lucide-react';
import { ApiError as ClientApiError, LEADS_CHANGED_EVENT, leadsApi } from '../../api/client';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { listMembers, memberName, type OrganizationMember } from '../../utils/agentsApi';

interface Props {
  leadId: string;
  /** The current assignment, as the pipeline last read it. */
  current: { id: string; name: string } | null;
  /** Called with the new agent once the server has recorded the assignment. */
  onAssigned: (agent: { id: string; name: string }) => void;
}

/** An agent_profiles id for this member, when they have one. */
type Assignable = OrganizationMember & { profileId: string };

/**
 * The owner's "Assign agent" button and picker.
 *
 * The list is the real roster from /api/agents: every ACTIVE member with an
 * agent profile — agents, plus the owner once they take leads. So a "Just me"
 * office sees exactly one choice, themselves, and a team sees everyone who can
 * sign in and work the lead. Suspended agents are left out: they cannot.
 *
 * An agent at their lead cap is shown but not selectable, with the count that
 * says why; the server enforces the same rule, so this is courtesy, not the
 * boundary. A paused owner (not taking new leads) stays selectable — pausing
 * stops AUTOMATIC routing, and a hand-assignment is the owner's explicit call.
 *
 * Owner-only. The route answers an agent with 403 regardless.
 */
export const AssignAgentControl: React.FC<Props> = ({ leadId, current, onAssigned }) => {
  const { role, user } = useAuth();
  const { setActiveView, setSelectedLeadId } = useApp();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Assignable[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Loaded when opened rather than with the modal: most views of a lead never
  // open the picker, and a fresh read means the lead counts are current.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setMembers(null);
    setError(null);
    listMembers()
      .then((all) => {
        if (!alive) return;
        setMembers(
          all
            .filter((m) => m.hasProfile && m.profileId && m.status === 'active')
            .map((m) => ({ ...m, profileId: m.profileId! })),
        );
      })
      .catch((e) => alive && setError(messageFor(e)));
    return () => {
      alive = false;
    };
  }, [open]);

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

  if (role !== 'owner') return null;

  const choose = async (m: Assignable): Promise<void> => {
    setSavingId(m.profileId);
    setError(null);
    try {
      const res = await leadsApi.assign(leadId, m.profileId);
      onAssigned(res.agent);
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      setOpen(false);
    } catch (e) {
      // The bridge client carries the server's own sentence ("… is at their
      // lead cap (25/25) …"), which says more than a generic code mapping.
      setError(e instanceof ClientApiError ? e.message : messageFor(e));
    } finally {
      setSavingId(null);
    }
  };

  const goToTeam = (): void => {
    setSelectedLeadId(null);
    setActiveView('agents');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition-colors cursor-pointer"
      >
        <UserPlus className="w-3.5 h-3.5 text-emerald-400" />
        <span>{current ? 'Reassign agent' : 'Assign agent'}</span>
        <ChevronDown className="w-3 h-3 text-slate-500" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Assign to agent"
          className="absolute right-0 mt-2 w-72 z-20 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-slate-800 text-2xs uppercase font-bold tracking-wide text-slate-500">
            Assign to
          </div>

          {error && (
            <div className="m-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {members === null && !error ? (
            <div className="p-3 text-xs text-slate-400 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading agents…
            </div>
          ) : members !== null && members.length === 0 ? (
            <div className="p-3 space-y-2 text-xs text-slate-400 leading-relaxed">
              <p>
                Nobody can take leads yet. Add an agent, or turn on <strong>I also take leads</strong>{' '}
                to work leads yourself.
              </p>
              <button
                type="button"
                onClick={goToTeam}
                className="text-emerald-300 hover:text-emerald-200 font-semibold cursor-pointer"
              >
                Go to Agent Team →
              </button>
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {members?.map((m) => {
                const isCurrent = current?.id === m.profileId;
                const atCap =
                  !isCurrent && m.maxActiveLeads !== null && m.activeLeads >= m.maxActiveLeads;
                const saving = savingId === m.profileId;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      disabled={atCap || savingId !== null || isCurrent}
                      onClick={() => void choose(m)}
                      title={atCap ? 'At their lead cap — raise it on Agent Team to assign more' : undefined}
                      className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left hover:bg-slate-800/70 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer"
                    >
                      <span className="min-w-0">
                        <span className={`block text-xs font-semibold truncate ${atCap ? 'text-slate-500' : 'text-slate-100'}`}>
                          {memberName(m)}
                          {m.id === user?.id && <span className="text-slate-500 font-normal"> · you</span>}
                        </span>
                        <span className="block text-2xs text-slate-500">
                          {m.activeLeads}
                          {m.maxActiveLeads !== null && ` / ${m.maxActiveLeads}`} leads
                          {atCap && ' · at cap'}
                          {!m.takingLeads && ' · paused'}
                        </span>
                      </span>
                      {saving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />
                      ) : isCurrent ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

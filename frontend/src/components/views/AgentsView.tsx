import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  Calendar,
  Clock,
  GitBranch,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import {
  listMembers,
  memberInitials,
  memberName,
  setAgentStatus,
  type OrganizationMember,
} from '../../utils/agentsApi';
import { AddAgentModal } from '../modals/AddAgentModal';
import { AgentCalendarPanel } from '../agents/AgentCalendarPanel';
import { EditAgentModal } from '../modals/EditAgentModal';

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  invited: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  suspended: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
};

const NEUTRAL_CHIP = 'bg-slate-800 text-slate-400 border-slate-700';

/** "9/16/2026", or an em dash when the column is null. */
const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString() : '—';

/**
 * The organization's people: who is in it, adding someone, suspending someone.
 *
 * Real data from Postgres via /api/agents — there is no demo roster behind this
 * screen any more. The owner-only controls below are a convenience: the server
 * answers an agent with a 403 whatever the UI renders.
 */
export const AgentsView: React.FC = () => {
  const { user, role } = useAuth();
  const isOwner = role === 'owner';

  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** The member whose calendar panel is open, if any. */
  const [calendarFor, setCalendarFor] = useState<OrganizationMember | null>(null);
  /**
   * The id of the agent being edited, or null. An id rather than a copy of the
   * row: the member is re-resolved from the roster below on every render, so a
   * reload underneath an open modal cannot leave it showing stale values.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The member whose status request is in flight, so only that card spins. */
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers(await listMembers());
      setError(null);
      setForbidden(false);
    } catch (e) {
      // A 403 is not a failure to report as an error — it is the answer for an
      // agent, and the screen says so instead of showing a red banner.
      setForbidden(e instanceof ApiError && e.code === 'FORBIDDEN');
      setError(e instanceof ApiError && e.code === 'FORBIDDEN' ? null : messageFor(e));
      setMembers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Agents only. The owner is a member of the organization and GET /api/agents
   * returns them, but they are not someone this screen manages: they cannot be
   * suspended, and they are the person reading the page. Filtered here rather
   * than in the query so the endpoint stays the organization's full member list.
   */
  const agents = members === null ? null : members.filter((m) => m.role === 'agent');

  // Resolved from the current roster rather than stored as a snapshot: if the
  // list reloads underneath an open modal, the modal is looking at the same row
  // the server last returned. A member who disappeared closes it.
  const editing = agents?.find((m) => m.id === editingId) ?? null;

  const handleSetStatus = async (
    member: OrganizationMember,
    status: 'suspended' | 'active',
  ): Promise<void> => {
    // Only the lockout asks. Reinstating is the undo, and putting a dialog in
    // front of the undo is how people stay stuck.
    if (
      status === 'suspended' &&
      !window.confirm(
        `Suspend ${memberName(member)}? They are signed out immediately and ` +
          `cannot sign in until you reactivate them.`,
      )
    ) {
      return;
    }

    setPendingId(member.id);
    setError(null);
    try {
      await setAgentStatus(member.id, status);
      await load();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Agents</h2>
          </div>
          <p className="text-xs text-slate-400">
            Add agents, edit their details, or suspend one.
          </p>
        </div>

        {isOwner && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              className="px-3 py-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${members === null ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={() => setAddOpen(true)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Agent
            </button>
          </div>
        )}
      </div>

      {/* Lead Routing (not built). Kept as a statement of intent, deliberately
          inert: nothing in the product assigns a lead to an agent yet, and a
          card that looks selectable would claim otherwise. */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-cyan-400" />
            Lead Distribution Algorithm
          </h3>
          <span className="text-2xs font-bold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
            Not implemented
          </span>
        </div>
        <p className="text-xs text-slate-400">
          Inbound leads are <strong className="text-slate-300">not</strong> routed to agents yet —
          every lead stays unassigned in the pipeline. These are the policies planned for a later
          phase; none of them is running.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs">
          {[
            { id: 'round_robin', title: 'Round-Robin', desc: 'Spread leads evenly across eligible agents.' },
            { id: 'geographic', title: 'Geographic Routing', desc: 'Match a lead to the agent covering its area.' },
            { id: 'availability', title: 'Availability First', desc: 'Only assign to agents with open calendar slots.' },
          ].map((opt) => (
            <div
              key={opt.id}
              className="p-3.5 rounded-xl border bg-slate-950/60 border-slate-800 space-y-1 opacity-60"
            >
              <span className="font-bold text-slate-300 block">{opt.title}</span>
              <p className="text-xs text-slate-500">{opt.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Something went wrong</div>
            {error}
          </div>
        </div>
      )}

      {/* Roster */}
      {agents === null ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 text-xs text-slate-400 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading team…
        </div>
      ) : forbidden ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
          <ShieldCheck className="w-6 h-6 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto">
            Only the organization owner can see and manage the team roster. Ask your owner if you
            need access.
          </div>
        </div>
      ) : agents.length === 0 ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
          <Users className="w-6 h-6 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400 leading-relaxed">
            No agents yet. Add your first agent to get started.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {agents.map((member) => {
            const pending = pendingId === member.id;
            const canSuspend =
              isOwner && member.role !== 'owner' && member.id !== user?.id && member.status !== 'suspended';

            return (
              <div
                key={member.id}
                className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col justify-between"
              >
                <div className="space-y-4">
                  {/* Identity */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 shadow-md flex items-center justify-center text-sm font-bold text-slate-300 font-mono shrink-0">
                        {memberInitials(member)}
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-white truncate">{memberName(member)}</h4>
                        <span className="text-xs text-slate-400 capitalize">
                          {member.role}
                          {member.id === user?.id && <span className="text-slate-600"> · you</span>}
                        </span>
                      </div>
                    </div>

                    {/* Deliberately the MEMBERSHIP status, not an availability
                        state: nothing in the product tracks whether an agent is
                        available, so a green "AVAILABLE" would be a claim the
                        system cannot back. This one is real, and it is what the
                        suspend action changes. */}
                    <span
                      className={`text-2xs font-bold px-2 py-0.5 rounded-full uppercase font-mono border shrink-0 ${
                        member.hasProfile ? (STATUS_STYLES[member.status] ?? NEUTRAL_CHIP) : NEUTRAL_CHIP
                      }`}
                      title={
                        member.hasProfile
                          ? 'Membership status'
                          : 'No agent profile — owners are not created with one'
                      }
                    >
                      {member.hasProfile ? member.status : 'No profile'}
                    </span>
                  </div>

                  {/* Contact */}
                  <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-slate-300">
                      <Phone className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      {member.phone ? (
                        <span className="font-mono">{member.phone}</span>
                      ) : (
                        <span className="text-slate-600">No phone</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-slate-300 min-w-0">
                      <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate">{member.email}</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-300">
                      <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>{member.timezone}</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-300 min-w-0">
                      <Briefcase className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      {member.title ? (
                        <span className="truncate">{member.title}</span>
                      ) : (
                        <span className="text-slate-600">No title</span>
                      )}
                    </div>
                  </div>

                  {/* Stats. Both are read from real tables; they are zero and
                      blank because nothing writes those tables yet, not because
                      the UI is filling space. */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                      <span className="text-slate-400 block text-2xs">Active Leads</span>
                      <span className="font-bold text-white font-mono text-sm">
                        {member.activeLeads}
                        {/* The cap is a real stored column, so it is shown next
                            to the real count. Nothing routes leads yet, which is
                            why the left number is 0 — the limit is still the
                            owner's setting rather than a guess. */}
                        {member.maxActiveLeads !== null && (
                          <span className="text-slate-500"> / {member.maxActiveLeads}</span>
                        )}
                      </span>
                    </div>
                    <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                      <span className="text-slate-400 block text-2xs">Member Since</span>
                      <span className="font-bold text-white font-mono text-sm">
                        {formatDate(member.memberSince)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Calendar + suspend */}
                <div className="pt-3 border-t border-slate-800 flex items-center gap-2">
                  {/* Opens the read-only calendar panel for members who have a
                      profile. An owner has none, so there is nothing to show.
                      Connecting is deliberately absent: the scheduling
                      account is connected once for the whole office, on
                      Integrations. */}
                  <button
                    onClick={() => member.hasProfile && setCalendarFor(member)}
                    disabled={!member.hasProfile}
                    title={
                      member.hasProfile
                        ? 'View working hours and upcoming appointments'
                        : 'Owners have no agent profile'
                    }
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                      member.hasProfile
                        ? 'bg-slate-800/60 hover:bg-slate-800 text-slate-300 cursor-pointer'
                        : 'bg-slate-800/60 text-slate-400 cursor-default'
                    }`}
                  >
                    <Calendar className="w-3.5 h-3.5" />
                    <span>
                      {member.calendarLinked ? 'On office calendar' : 'Not on calendar'}
                    </span>
                  </button>

                  {isOwner && (
                    <button
                      onClick={() => setEditingId(member.id)}
                      disabled={pending}
                      title="Edit this agent"
                      aria-label={`Edit ${memberName(member)}`}
                      className="p-2 bg-slate-800 hover:bg-emerald-600/20 text-slate-400 hover:text-emerald-300 rounded-lg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {isOwner && canSuspend && (
                    <button
                      onClick={() => void handleSetStatus(member, 'suspended')}
                      disabled={pending}
                      title="Suspend this agent"
                      aria-label={`Suspend ${memberName(member)}`}
                      className="p-2 bg-slate-800 hover:bg-rose-600/20 text-slate-400 hover:text-rose-300 rounded-lg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
                    >
                      {pending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <UserMinus className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>

                {isOwner && member.status === 'suspended' && (
                  <div className="-mt-2 space-y-2">
                    <p className="text-xs text-slate-500 text-center">
                      Suspended — this member can no longer sign in.
                    </p>
                    <button
                      onClick={() => void handleSetStatus(member, 'active')}
                      disabled={pending}
                      title="Reactivate this agent"
                      aria-label={`Reactivate ${memberName(member)}`}
                      className="w-full py-2 bg-slate-800 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {pending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <UserPlus className="w-3.5 h-3.5" />
                      )}
                      <span>Reactivate</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddAgentModal isOpen={addOpen} onClose={() => setAddOpen(false)} onCreated={() => void load()} />

      {calendarFor && (
        <AgentCalendarPanel
          userId={calendarFor.id}
          memberName={memberName(calendarFor)}
          onClose={() => setCalendarFor(null)}
        />
      )}

      {/* Mounted only while editing, so the form always opens on fresh values. */}
      {editing && (
        <EditAgentModal
          key={editing.id}
          member={editing}
          onClose={() => setEditingId(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
};

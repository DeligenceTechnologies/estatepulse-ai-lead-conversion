import React, { useCallback, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Ban,
  Clock,
  GitFork,
  MessageSquare,
  Pencil,
  PhoneCall,
  Plus,
  RotateCw,
  ShieldAlert,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { EnrollLeadsModal } from '../modals/EnrollLeadsModal';
import { SequenceEditorModal } from '../modals/SequenceEditorModal';
import { ContactWindowCard } from './ContactWindowCard';
import {
  archiveSequence,
  cumulativeDays,
  formatDelay,
  listEnrollments,
  listSequences,
  stopEnrollment,
  TRIGGER_LABELS,
  type Enrollment,
  type Sequence,
} from '../../utils/sequencesApi';

/**
 * Nurture sequences and the leads inside them.
 *
 * Previously this rendered three hardcoded n8n workflow cards out of mockData.
 * Everything here is now the real tables, and nothing is seeded: an office
 * starts with no sequences and builds its own. The counts and enrolments come
 * from `sequence_enrollments` — the same table the runner claims from, so what
 * this screen says and what the runner will do cannot drift apart.
 *
 * Adding a lead is the manual part. Everything after it is not: the runner
 * fires the steps, and a lead leaves because of something that happened to
 * them — an opt-out, a booking, a takeover, or running out of steps. A
 * sequence can also claim a temperature and enrol those leads on
 * qualification, which is the one automatic way in.
 *
 * Authoring is owner-only server-side. The buttons are hidden from an agent as
 * a courtesy; the 403 is the actual boundary.
 */

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  processing: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  paused: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  completed: 'bg-slate-700/60 text-slate-300 border-slate-600',
  stopped: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
};

const relative = (iso: string | null): string => {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const mins = Math.round(ms / 60_000);
  if (Math.abs(mins) < 60) return mins <= 0 ? 'due now' : `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 48) return hours <= 0 ? 'overdue' : `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
};

export const FollowUpsView: React.FC = () => {
  const { setSelectedLeadId } = useApp();
  const { role } = useAuth();
  const isOwner = role === 'owner';

  const [editing, setEditing] = useState<Sequence | null | undefined>(undefined);
  const [enrolling, setEnrolling] = useState<Sequence | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchSequences = useCallback(() => listSequences(), []);
  const fetchEnrollments = useCallback(() => listEnrollments(), []);

  const sequencesQuery = useLiveQuery<Sequence[]>(fetchSequences, { baseIntervalMs: 15_000 });
  const enrollmentsQuery = useLiveQuery<Enrollment[]>(fetchEnrollments, { baseIntervalMs: 15_000 });

  const sequences = sequencesQuery.data ?? [];
  const enrollments = enrollmentsQuery.data ?? [];

  const refreshAll = () => {
    sequencesQuery.refresh();
    enrollmentsQuery.refresh();
  };

  const onArchive = async (seq: Sequence) => {
    // An archive stops every live enrolment in it, so the count is stated
    // before the confirm rather than discovered afterwards.
    const live = seq.activeCount + seq.pausedCount;
    const warning = live
      ? `Archive "${seq.name}"? ${live} lead${live === 1 ? '' : 's'} will stop receiving it.`
      : `Archive "${seq.name}"?`;
    if (!window.confirm(warning)) return;
    setBusyId(seq.id);
    try {
      await archiveSequence(seq.id);
      refreshAll();
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (e: Enrollment) => {
    if (!window.confirm(`Remove ${e.leadName} from ${e.sequenceName}?`)) return;
    setBusyId(e.id);
    try {
      await stopEnrollment(e.id);
      refreshAll();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Follow-Up Sequences</h2>
          <p className="text-xs text-slate-400">
            Nurture for warm and cold leads, run from the database so a deploy cannot cancel it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshAll}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <RotateCw className={`w-3.5 h-3.5 ${sequencesQuery.refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {isOwner && sequences.length > 0 && (
            <button
              onClick={() => setEditing(null)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              New sequence
            </button>
          )}
        </div>
      </div>

      {(sequencesQuery.stale || enrollmentsQuery.stale) && (
        <div className="flex items-center gap-2 text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/40 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          Showing the last good result — the most recent refresh failed.
        </div>
      )}

      {sequences.length > 0 && (
      <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl text-xs text-slate-300 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <div className="font-bold text-slate-100">What stops a sequence</div>
          <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
            A reply of STOP or UNSUBSCRIBE, a booking, a human takeover, the lead going hot, or
            running out of steps. Nothing else. Any other inbound reply pauses the sequence so we
            are not texting over a live conversation, and every step is held back until the
            office&apos;s quiet hours are over rather than being skipped.
          </p>
        </div>
      </div>
      )}

      {/* The window every sequence obeys. Editable here as well as in AI
          Settings because it is one org-wide setting: an office looking at its
          nurture drips has no way to know a quiet window governs them unless it
          is in front of them. */}
      {isOwner && (
        <ContactWindowCard blurb="Every sequence below is held inside this window. A step that comes due during quiet hours is sent when it reopens, never skipped." />
      )}

      {/* Sequences */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {sequences.length === 0 && (
          <div className="lg:col-span-2 border border-dashed border-slate-800 rounded-2xl py-14 px-6 text-center space-y-4">
            {sequencesQuery.data === null ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : (
              <>
                <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto">
                  <GitFork className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="space-y-1.5 max-w-md mx-auto">
                  <h3 className="text-sm font-bold text-white">No follow-up sequences yet</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    A sequence is a series of texts and AI callbacks, spaced out over days or
                    weeks. Build one, then add leads to it by hand or in bulk — or point it at a
                    temperature to enrol those leads automatically.
                  </p>
                </div>
                {isOwner ? (
                  <button
                    onClick={() => setEditing(null)}
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Create a sequence
                  </button>
                ) : (
                  <p className="text-[11px] text-slate-500">
                    Ask an owner to set one up.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {sequences.map((seq) => {
          const days = cumulativeDays(seq.steps);
          return (
            <div
              key={seq.id}
              className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                  {seq.code}
                </span>
                <div className="flex items-center gap-1.5">
                  {/* The count alone on the badge, every condition spelled
                      out on hover: which leads land here is the question asked
                      of this screen, and it does not fit in a pill. */}
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                      seq.enrollTriggers.length
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                    title={
                      seq.enrollTriggers.length
                        ? 'Adds leads automatically when: ' +
                          seq.enrollTriggers
                            .map((t) => TRIGGER_LABELS[t] ?? t)
                            .join(', ')
                        : 'Leads are only added by hand'
                    }
                  >
                    {seq.enrollTriggers.length
                      ? `auto: ${seq.enrollTriggers.length} condition${seq.enrollTriggers.length > 1 ? 's' : ''}`
                      : 'manual only'}
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                      STATUS_STYLES[seq.status] ?? STATUS_STYLES.completed
                    }`}
                  >
                    {seq.status}
                  </span>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-bold text-white">{seq.name}</h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">{seq.description}</p>
              </div>

              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Steps
                </div>
                {seq.steps.map((step, idx) => (
                  <div
                    key={step.stepOrder}
                    className="flex items-start gap-2.5 text-xs bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/60"
                  >
                    <div className="w-5 h-5 rounded-full bg-slate-800 text-[10px] font-bold font-mono text-emerald-400 flex items-center justify-center shrink-0">
                      {step.stepOrder}
                    </div>
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1.5 font-semibold text-slate-200 flex-wrap">
                        {step.actionType === 'sms' ? (
                          <MessageSquare className="w-3 h-3 text-cyan-400" />
                        ) : (
                          <PhoneCall className="w-3 h-3 text-emerald-400" />
                        )}
                        <span className="capitalize">
                          {step.actionType === 'sms' ? 'SMS' : 'AI callback'}
                        </span>
                        <span className="text-slate-600">•</span>
                        <span className="text-amber-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          day {days[idx]}
                        </span>
                        <span className="text-slate-600 text-[10px]">
                          (+{formatDelay(step.delayMinutes)})
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        {step.messageTemplate ?? step.voicePrompt}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-3 border-t border-slate-800 grid grid-cols-4 gap-2 text-center">
                {[
                  ['Active', seq.activeCount, 'text-emerald-400'],
                  ['Paused', seq.pausedCount, 'text-amber-400'],
                  ['Done', seq.completedCount, 'text-slate-300'],
                  ['Stopped', seq.stoppedCount, 'text-rose-400'],
                ].map(([label, count, color]) => (
                  <div key={String(label)}>
                    <div className={`font-mono font-bold text-sm ${color}`}>{count}</div>
                    <div className="text-[10px] text-slate-500 uppercase">{label}</div>
                  </div>
                ))}
              </div>

              {isOwner && seq.status !== 'archived' && (
                <div className="pt-3 border-t border-slate-800 flex items-center gap-2">
                  <button
                    onClick={() => setEnrolling(seq)}
                    disabled={seq.status !== 'active'}
                    title={
                      seq.status === 'active'
                        ? undefined
                        : 'Only an active sequence can accept leads'
                    }
                    className="flex-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    Add leads
                  </button>
                  <button
                    onClick={() => setEditing(seq)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    onClick={() => void onArchive(seq)}
                    disabled={busyId === seq.id}
                    title="Archive — keeps the history, stops every live enrolment"
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-300 text-xs border border-slate-700 cursor-pointer disabled:opacity-40"
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Enrolments */}
      {sequences.length > 0 && (
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <span className="text-sm font-bold text-white">Enrolled leads</span>
          <span className="text-[11px] text-slate-500">{enrollments.length} shown</span>
        </div>

        {enrollments.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-10">
            {enrollmentsQuery.data === null
              ? 'Loading…'
              : 'Nobody is in a sequence yet. Warm and cold leads are enrolled the moment an AI call returns their temperature.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-slate-500 bg-slate-950/60">
                <tr>
                  <th className="text-left font-semibold px-5 py-2">Lead</th>
                  <th className="text-left font-semibold px-3 py-2">Sequence</th>
                  <th className="text-left font-semibold px-3 py-2">Step</th>
                  <th className="text-left font-semibold px-3 py-2">Status</th>
                  <th className="text-left font-semibold px-3 py-2">Next action</th>
                  <th className="text-left font-semibold px-3 py-2">Added by</th>
                  <th className="text-left font-semibold px-3 py-2">Why it stopped</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {enrollments.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelectedLeadId(e.leadId)}
                    className="border-t border-slate-800/60 hover:bg-slate-800/40 cursor-pointer"
                  >
                    <td className="px-5 py-2.5">
                      <div className="font-semibold text-slate-100">{e.leadName}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{e.leadPhone}</div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-300 font-mono text-[11px]">
                      {e.sequenceCode}
                    </td>
                    <td className="px-3 py-2.5 text-slate-400">{e.currentStep}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                          STATUS_STYLES[e.status] ?? STATUS_STYLES.completed
                        }`}
                      >
                        {e.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400">
                      <span title={e.nextActionAt ?? ''}>{relative(e.nextActionAt)}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`text-[10px] uppercase font-semibold ${
                          e.enrolledBy === 'auto' ? 'text-slate-500' : 'text-cyan-400'
                        }`}
                      >
                        {e.enrolledBy}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400">
                      {e.stoppedReason === 'opted_out' ? (
                        <span className="flex items-center gap-1 text-rose-400">
                          <Ban className="w-3 h-3" />
                          opted out
                        </span>
                      ) : (
                        <span title={e.lastError ?? ''}>{e.stoppedReason ?? '—'}</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {isOwner && (e.status === 'active' || e.status === 'paused') && (
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void onRemove(e);
                          }}
                          disabled={busyId === e.id}
                          title="Remove from this sequence"
                          className="text-slate-500 hover:text-rose-400 disabled:opacity-40 cursor-pointer"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {editing !== undefined && (
        <SequenceEditorModal
          sequence={editing}
          onClose={() => setEditing(undefined)}
          onSaved={refreshAll}
        />
      )}

      {enrolling && (
        <EnrollLeadsModal
          sequence={enrolling}
          onClose={() => setEnrolling(null)}
          onEnrolled={refreshAll}
        />
      )}
    </div>
  );
};

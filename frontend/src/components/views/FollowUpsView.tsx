import React, { useCallback, useEffect, useState } from 'react';
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
  ShieldAlert,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { confirmToast } from '../../lib/toast';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { messageFor } from '../../lib/api';
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
import { Button, IconButton } from '../common/Button';

/**
 * Nurture sequences and the leads inside them.
 *
 * Nothing is seeded: an office starts with no sequences and builds its own. The counts and enrolments come
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

/** Status pills: a soft tint, a hairline border, readable text and a dot of one hue. */
const STATUS_STYLES: Record<string, { pill: string; dot: string }> = {
  active: { pill: 'bg-green-500/10 text-green-300 border-green-500/25', dot: 'bg-green-400' },
  processing: { pill: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/25', dot: 'bg-cyan-400' },
  paused: { pill: 'bg-amber-500/10 text-amber-300 border-amber-500/25', dot: 'bg-amber-400' },
  completed: { pill: 'bg-slate-500/10 text-slate-300 border-slate-500/25', dot: 'bg-slate-400' },
  stopped: { pill: 'bg-rose-500/10 text-rose-300 border-rose-500/25', dot: 'bg-rose-400' },
  inactive: { pill: 'bg-slate-500/10 text-slate-400 border-slate-500/25', dot: 'bg-slate-500' },
  archived: { pill: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/25', dot: 'bg-zinc-400' },
};

const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const tone = STATUS_STYLES[status] ?? STATUS_STYLES.completed;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-2xs font-semibold pl-2 pr-2.5 py-0.5 rounded-full border capitalize ${tone.pill}`}
    >
      <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
      {status}
    </span>
  );
};

/** "no_more_steps" -> "No more steps". */
const humanize = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** A small figure at the top of the page. */
const Stat: React.FC<{ label: string; value: number; tone: string }> = ({ label, value, tone }) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl px-4 py-3 shadow-lg">
    <p className="text-2xs font-semibold text-slate-400 flex items-center gap-1.5">
      <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${tone}`} />
      {label}
    </p>
    <p className="text-xl font-bold text-white tracking-tight mt-0.5">{value.toLocaleString()}</p>
  </div>
);

/**
 * `now` is passed in, from a clock the view ticks, rather than read here: the
 * enrolment rows do not change while a step waits, so a countdown that only
 * recomputed when they did would sit at its first value until the step fired.
 */
const relative = (iso: string | null, now: number): string => {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - now;
  // Rounded up, so a step 30 seconds away reads "in 1 min", never "due now".
  const mins = Math.ceil(ms / 60_000);
  if (Math.abs(mins) < 60) return mins <= 0 ? 'due now' : `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 48) return hours <= 0 ? 'overdue' : `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
};

/** How often the "Next action" countdown recomputes. */
const COUNTDOWN_TICK_MS = 15_000;

export const FollowUpsView: React.FC = () => {
  const { setSelectedLeadId } = useApp();
  const { role } = useAuth();
  const isOwner = role === 'owner';

  const [editing, setEditing] = useState<Sequence | null | undefined>(undefined);
  const [enrolling, setEnrolling] = useState<Sequence | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Drives the "Next action" countdown. See relative().
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(t);
  }, []);

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
    if (!(await confirmToast(warning, 'Archive'))) return;
    setBusyId(seq.id);
    try {
      await archiveSequence(seq.id);
      toast.success(`Archived "${seq.name}".`);
      refreshAll();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (e: Enrollment) => {
    if (!(await confirmToast(`Remove ${e.leadName} from ${e.sequenceName}?`, 'Remove'))) return;
    setBusyId(e.id);
    try {
      await stopEnrollment(e.id);
      toast.success(`Removed ${e.leadName} from ${e.sequenceName}.`);
      refreshAll();
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusyId(null);
    }
  };

  const live = sequences.filter((q) => q.status !== 'archived');
  const totals = live.reduce(
    (t, q) => ({
      active: t.active + q.activeCount,
      paused: t.paused + q.pausedCount,
      done: t.done + q.completedCount,
    }),
    { active: 0, paused: 0, done: 0 },
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Follow-Up Sequences</h2>
          <p className="text-xs text-slate-400">Automatic texts and AI calls that keep warm and cold leads engaged.</p>
        </div>
        {isOwner && sequences.length > 0 && (
          <Button onClick={() => setEditing(null)} icon={<Plus />}>
            New sequence
          </Button>
        )}
      </div>

      {(sequencesQuery.stale || enrollmentsQuery.stale) && (
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-950/40 border border-amber-800/40 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          Showing the last saved data. The latest update failed.
        </div>
      )}

      {sequences.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Sequences" value={live.length} tone="bg-blue-400" />
          <Stat label="Leads active" value={totals.active} tone="bg-green-400" />
          <Stat label="Leads paused" value={totals.paused} tone="bg-amber-400" />
          <Stat label="Leads finished" value={totals.done} tone="bg-slate-400" />
        </div>
      )}

      {sequences.length > 0 && (
        <div className="bg-slate-900/90 border border-slate-800 px-4 py-3 rounded-2xl flex items-start gap-3 shadow-lg">
          <span className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
          </span>
          <div>
            <div className="text-xs font-bold text-slate-100">When a sequence stops</div>
            <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
              The lead replies STOP, books, is taken over by an agent, turns hot, or gets every step. Any other reply
              pauses it.
            </p>
          </div>
        </div>
      )}

      {/* The window every sequence obeys: one org-wide setting, shown here because it governs these drips. */}
      {isOwner && <ContactWindowCard blurb="Steps are only sent inside these hours. A step due outside them waits." />}

      {/* Sequences */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {sequences.length === 0 && (
          <div className="lg:col-span-2 border border-dashed border-slate-800 rounded-2xl py-14 px-6 text-center space-y-4">
            {sequencesQuery.data === null ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : (
              <>
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mx-auto">
                  <GitFork className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="space-y-1.5 max-w-md mx-auto">
                  <h3 className="text-sm font-bold text-white">No sequences yet</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    A sequence sends texts and AI calls over days or weeks. Create one, then add leads to it.
                  </p>
                </div>
                {isOwner ? (
                  <Button onClick={() => setEditing(null)} icon={<Plus />}>
                    Create a sequence
                  </Button>
                ) : (
                  <p className="text-xs text-slate-500">Ask an owner to set one up.</p>
                )}
              </>
            )}
          </div>
        )}

        {sequences.map((seq) => {
          const days = cumulativeDays(seq.steps);
          const auto = seq.enrollTriggers.length > 0;
          return (
            <div
              key={seq.id}
              className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl flex flex-col overflow-hidden hover:border-slate-700 transition-colors"
            >
              {/* Header */}
              <div className="p-5 pb-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-bold text-white truncate">{seq.name}</h3>
                    <span className="text-2xs font-mono text-slate-500">{seq.code}</span>
                  </div>
                  <StatusPill status={seq.status} />
                </div>
                {seq.description && <p className="text-xs text-slate-400 leading-relaxed">{seq.description}</p>}
                <span
                  className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-0.5 rounded-full border ${
                    auto
                      ? 'bg-violet-500/10 text-violet-300 border-violet-500/25'
                      : 'bg-slate-500/10 text-slate-300 border-slate-500/25'
                  }`}
                  title={
                    auto
                      ? 'Adds leads automatically when: ' + seq.enrollTriggers.map((t) => TRIGGER_LABELS[t] ?? t).join(', ')
                      : 'Leads are only added by hand'
                  }
                >
                  {auto ? `Auto-adds leads · ${seq.enrollTriggers.length} rule${seq.enrollTriggers.length > 1 ? 's' : ''}` : 'Added by hand'}
                </span>
              </div>

              {/* Steps, as a timeline */}
              <div className="px-5 pb-4">
                <div className="text-2xs font-bold text-slate-400 mb-2">
                  {seq.steps.length} step{seq.steps.length === 1 ? '' : 's'} · {days[days.length - 1] ?? 0} days
                </div>
                <ol className="relative space-y-2 before:absolute before:left-[11px] before:top-3 before:bottom-3 before:w-px before:bg-slate-800">
                  {seq.steps.map((step, idx) => {
                    const sms = step.actionType === 'sms';
                    return (
                      <li key={step.stepOrder} className="relative flex items-start gap-3">
                        <span
                          className={`relative z-10 w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${
                            sms
                              ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          }`}
                        >
                          {sms ? <MessageSquare className="w-3 h-3" /> : <PhoneCall className="w-3 h-3" />}
                        </span>
                        <div className="min-w-0 flex-1 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2">
                          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                            {sms ? 'Text message' : 'AI call'}
                            <span className="ml-auto inline-flex items-center gap-1 text-2xs font-semibold text-amber-300">
                              <Clock className="w-3 h-3" />
                              Day {days[idx]}
                              <span className="text-slate-500 font-normal">(+{formatDelay(step.delayMinutes)})</span>
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed mt-0.5 line-clamp-2">
                            {step.messageTemplate ?? step.voicePrompt}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {/* Counts */}
              <div className="mt-auto grid grid-cols-4 border-t border-slate-800 divide-x divide-slate-800">
                {(
                  [
                    ['Active', seq.activeCount, 'bg-green-400'],
                    ['Paused', seq.pausedCount, 'bg-amber-400'],
                    ['Done', seq.completedCount, 'bg-slate-400'],
                    ['Stopped', seq.stoppedCount, 'bg-rose-400'],
                  ] as const
                ).map(([label, count, dot]) => (
                  <div key={label} className="py-3 text-center">
                    <div className="text-base font-bold text-white">{count}</div>
                    <div className="text-2xs text-slate-400 inline-flex items-center gap-1">
                      <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                      {label}
                    </div>
                  </div>
                ))}
              </div>

              {isOwner && seq.status !== 'archived' && (
                <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/40 flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => setEnrolling(seq)}
                    disabled={seq.status !== 'active'}
                    title={seq.status === 'active' ? undefined : 'Only an active sequence can take leads'}
                    icon={<UserPlus />}
                  >
                    Add leads
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(seq)} icon={<Pencil />}>
                    Edit
                  </Button>
                  <IconButton
                    variant="secondary"
                    size="sm"
                    className="hover:text-rose-300!"
                    onClick={() => void onArchive(seq)}
                    loading={busyId === seq.id}
                    title="Archive: keeps the history, stops it for every lead"
                    aria-label="Archive sequence"
                    icon={<Archive />}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Enrolments */}
      {sequences.length > 0 && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
            <span className="text-sm font-bold text-white">Leads in sequences</span>
            <span className="text-2xs font-semibold text-slate-300 bg-slate-500/10 border border-slate-500/25 rounded-full px-2.5 py-0.5">
              {enrollments.length}
            </span>
          </div>

          {enrollments.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-10">
              {enrollmentsQuery.data === null ? 'Loading…' : 'No leads in a sequence yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-2xs text-slate-400 bg-slate-950/60">
                  <tr>
                    <th className="text-left font-semibold px-5 py-2.5">Lead</th>
                    <th className="text-left font-semibold px-3 py-2.5">Sequence</th>
                    <th className="text-left font-semibold px-3 py-2.5">Step</th>
                    <th className="text-left font-semibold px-3 py-2.5">Status</th>
                    <th className="text-left font-semibold px-3 py-2.5">Next</th>
                    <th className="text-left font-semibold px-3 py-2.5">Added</th>
                    <th className="text-left font-semibold px-3 py-2.5">Stop reason</th>
                    <th className="px-5 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {enrollments.map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => setSelectedLeadId(e.leadId)}
                      className="border-t border-slate-800 hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="font-semibold text-slate-100">{e.leadName}</div>
                        <div className="text-2xs text-slate-500 font-mono">{e.leadPhone}</div>
                      </td>
                      <td className="px-3 py-3 text-slate-300">{e.sequenceName ?? e.sequenceCode}</td>
                      <td className="px-3 py-3 text-slate-300">
                        {e.awaitingReply ? <span className="text-amber-300">Waiting for reply</span> : `Step ${e.currentStep}`}
                      </td>
                      <td className="px-3 py-3">
                        <StatusPill status={e.status} />
                      </td>
                      <td className="px-3 py-3 text-slate-300 whitespace-nowrap">
                        <span title={e.nextActionAt ?? ''}>{relative(e.nextActionAt, now)}</span>
                      </td>
                      <td className="px-3 py-3 text-slate-400">{e.enrolledBy === 'auto' ? 'Auto' : 'By hand'}</td>
                      <td className="px-3 py-3 text-slate-400">
                        {e.stoppedReason === 'opted_out' ? (
                          <span className="inline-flex items-center gap-1 text-rose-300">
                            <Ban className="w-3 h-3" />
                            Opted out
                          </span>
                        ) : (
                          <span title={e.lastError ?? ''}>{e.stoppedReason ? humanize(e.stoppedReason) : '—'}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {isOwner && (e.status === 'active' || e.status === 'paused') && (
                          <IconButton
                            size="sm"
                            className="hover:text-rose-300!"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void onRemove(e);
                            }}
                            disabled={busyId === e.id}
                            aria-label="Remove from this sequence"
                            title="Remove from this sequence"
                            icon={<XCircle />}
                          />
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
        <SequenceEditorModal sequence={editing} onClose={() => setEditing(undefined)} onSaved={refreshAll} />
      )}

      {enrolling && (
        <EnrollLeadsModal sequence={enrolling} onClose={() => setEnrolling(null)} onEnrolled={refreshAll} />
      )}
    </div>
  );
};

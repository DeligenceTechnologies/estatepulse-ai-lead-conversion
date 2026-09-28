import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Info,
  Lock,
  MessageSquare,
  PhoneCall,
  Plus,
  Route,
  Settings2,
  Trash2,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { messageFor } from '../../lib/api';
import {
  createSequence,
  formatDelay,
  replaceSteps,
  updateSequence,
  type ActionType,
  type Sequence,
  type SequenceStatus,
  type StepDraft,
  ENROLL_TRIGGERS,
  type EnrollTrigger,
} from '../../utils/sequencesApi';

/**
 * Author a nurture sequence.
 *
 * Two server calls on save when editing, not one: the sequence's own fields
 * are a PATCH and its steps are a PUT that replaces the whole list. They are
 * separate endpoints because renaming a sequence and rewriting what it sends
 * are different-sized decisions, and the steps call has to clamp live
 * enrolments afterwards.
 *
 * Laid out in two columns rather than one long scroll: what the sequence IS
 * (name, code, status) and what PUTS LEADS IN IT are separate decisions that
 * get read side by side, and stacking them pushed the conditions below the
 * fold where nobody found them. Steps run full width underneath, because a
 * step's message needs the room and the list is the part that grows.
 *
 * The delay on each step is the gap from the PREVIOUS step, while the column
 * on the right shows the cumulative day it lands on — that is the number the
 * spec and any human actually reason about, and it is easy to get wrong when
 * editing the middle of a list.
 */

const DAY = 1440;

interface Props {
  /** Null creates a new sequence; a sequence edits it. */
  sequence: Sequence | null;
  onClose: () => void;
  onSaved: () => void;
}

const blankStep = (): StepDraft => ({
  actionType: 'sms',
  delayMinutes: DAY,
  messageTemplate: '',
  voicePrompt: '',
  maxAttempts: 1,
});

const label = 'block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1';
const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';
const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl';

const GROUPS = [
  {
    key: 'qualified' as const,
    title: 'The AI reached them and reported back',
    dot: 'bg-emerald-400',
  },
  {
    key: 'negative' as const,
    title: 'The strategy ran out without a result',
    dot: 'bg-slate-500',
  },
];

export const SequenceEditorModal: React.FC<Props> = ({ sequence, onClose, onSaved }) => {
  const isNew = sequence === null;

  const [name, setName] = useState(sequence?.name ?? '');
  const [code, setCode] = useState(sequence?.code ?? '');
  const [description, setDescription] = useState(sequence?.description ?? '');
  const [status, setStatus] = useState<SequenceStatus>(sequence?.status ?? 'active');
  const [triggers, setTriggers] = useState<EnrollTrigger[]>(sequence?.enrollTriggers ?? []);
  const [steps, setSteps] = useState<StepDraft[]>(
    sequence?.steps.map((s) => ({
      actionType: s.actionType,
      delayMinutes: s.delayMinutes,
      messageTemplate: s.messageTemplate ?? '',
      voicePrompt: s.voicePrompt ?? '',
      maxAttempts: s.maxAttempts,
    })) ?? [blankStep()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Status is a toggle, but the column holds three values.
   *
   * Switching OFF a sequence that arrived archived must leave it archived
   * rather than quietly reviving it as merely inactive — opening the editor to
   * fix a typo should not resurrect something that was deliberately retired.
   * Switching ON is unambiguous either way.
   */
  const isArchived = status === 'archived';
  const isActive = status === 'active';
  const pausedStatus: SequenceStatus = sequence?.status === 'archived' ? 'archived' : 'inactive';

  /**
   * What was on screen when the editor opened. Compared against, rather than a
   * boolean flipped on every keystroke, so that typing a character and deleting
   * it again correctly leaves the sequence unchanged.
   */
  const initial = useMemo(
    () => JSON.stringify({ n: name, d: description, s: status, t: [...triggers].sort(), st: steps }),
    // Deliberately empty: this is the snapshot at open, not a live value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const dirty =
    JSON.stringify({ n: name, d: description, s: status, t: [...triggers].sort(), st: steps }) !==
    initial;

  const patchStep = (i: number, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const move = (i: number, by: number) =>
    setSteps((prev) => {
      const next = [...prev];
      const j = i + by;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const toggle = (value: EnrollTrigger) =>
    setTriggers((prev) =>
      prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value],
    );

  let running = 0;
  const cumulative = steps.map((s) => {
    running += s.delayMinutes || 0;
    return running;
  });
  const totalDays = Math.round((cumulative[cumulative.length - 1] / DAY) * 10) / 10;
  // '1 days' reads as a bug in a screen whose whole job is scheduling.
  const daysLabel = `${totalDays} day${totalDays === 1 ? '' : 's'}`;

  // Read back in the catalogue's order rather than tick order, so the sentence
  // reads the same however the boxes were clicked.
  const chosen = ENROLL_TRIGGERS.filter((t) => triggers.includes(t.value));
  const smsCount = steps.filter((s) => s.actionType === 'sms').length;
  const voiceCount = steps.length - smsCount;

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const payloadSteps: StepDraft[] = steps.map((s) => ({
        actionType: s.actionType,
        delayMinutes: s.delayMinutes,
        maxAttempts: s.maxAttempts ?? 1,
        // Send only the field the channel uses. The server nulls the other one
        // regardless; not sending it keeps the failing field unambiguous when
        // validation rejects an empty message.
        ...(s.actionType === 'sms'
          ? { messageTemplate: s.messageTemplate ?? '' }
          : { voicePrompt: s.voicePrompt ?? '' }),
      }));

      if (isNew) {
        await createSequence({
          name,
          code,
          description: description || undefined,
          status,
          enrollTriggers: triggers,
          steps: payloadSteps,
        });
      } else {
        await updateSequence(sequence.id, {
          name,
          description: description || null,
          status,
          enrollTriggers: triggers,
        });
        await replaceSteps(sequence.id, payloadSteps);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    // The dialog is height-capped and scrolls INTERNALLY. Letting the backdrop
    // scroll instead put the footer's containing block taller than the viewport,
    // so `sticky bottom-0` pinned it to the bottom of the SCREEN and it floated
    // across the middle of the steps. A flex column with one scrolling child is
    // what actually keeps a footer at the bottom of a tall dialog.
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3 md:p-6">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-6xl shadow-2xl flex flex-col max-h-full">
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-base font-bold text-white truncate">
                {isNew ? 'New follow-up sequence' : name || sequence.name}
              </h3>
              {!isNew && (
                <>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${
                      status === 'active'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {status === 'active' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    )}
                    {status}
                  </span>
                  <span className="text-[11px] text-slate-400 font-mono bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                    {sequence.code}
                  </span>
                </>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Steps run in order. Each delay is measured from the step before it.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 cursor-pointer shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-5 md:p-6 space-y-5">
          {error && (
            <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* ---- Left: what the sequence is ----
                Sticky because it is the shorter column: it stays beside the
                conditions as they scroll instead of leaving dead space. */}
            <section className="lg:col-span-5 space-y-4 lg:sticky lg:top-2">
              <div className={`${card} space-y-4`}>
                <div className="border-b border-slate-800 pb-3">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <Settings2 className="w-4 h-4 text-emerald-400" />
                    Sequence details
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    What it is called and whether it is running.
                  </p>
                </div>

                <div>
                  <label className={label}>Name</label>
                  <input
                    className={input}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Open house follow-up"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className={label.replace('mb-1', '')}>Code</label>
                    {!isNew && (
                      <span className="text-[10px] text-amber-400 font-semibold flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Permanent
                      </span>
                    )}
                  </div>
                  <input
                    className={`${input} font-mono ${isNew ? '' : 'opacity-60 cursor-not-allowed'}`}
                    value={code}
                    disabled={!isNew}
                    onChange={(e) =>
                      setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))
                    }
                    placeholder="OPEN_HOUSE"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    {isNew
                      ? 'UPPER_SNAKE_CASE. Permanent once saved.'
                      : 'A code is the stable handle for a sequence and cannot be changed.'}
                  </p>
                </div>

                <div>
                  <label className={label}>Description</label>
                  <textarea
                    className={`${input} h-20 resize-none leading-relaxed`}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="When should somebody be put in this?"
                  />
                </div>

                <div className="pt-3 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setStatus(isActive ? pausedStatus : 'active')}
                    aria-pressed={isActive}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800 hover:border-slate-700 transition cursor-pointer text-left"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isActive ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                        />
                        <span
                          className={`text-xs font-bold ${
                            isActive ? 'text-white' : 'text-slate-300'
                          }`}
                        >
                          {isArchived ? 'Archived' : isActive ? 'Active Status' : 'Paused'}
                        </span>
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-0.5 leading-normal">
                        {isActive
                          ? 'Can send sequences and accept new incoming leads'
                          : isArchived
                            ? 'Archived and stopped. Switching on makes it active again.'
                            : 'Keeps the leads it has, sends nothing, and releases its conditions'}
                      </span>
                    </span>
                    <span
                      className={`w-10 h-5 rounded-full relative shrink-0 transition-colors ${
                        isActive ? 'bg-emerald-500' : 'bg-slate-700'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                          isActive ? 'left-[22px]' : 'left-0.5'
                        }`}
                      />
                    </span>
                  </button>
                </div>
              </div>

              {/* A plain-English read-back of the two halves of this form.
                  The conditions are ticked in the right-hand column and the
                  steps are further down the page, so without this nobody ever
                  sees the whole rule in one place — which is exactly the thing
                  they are trying to get right. */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
                <h5 className="text-[11px] font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Route className="w-3.5 h-3.5 text-sky-400" />
                  In plain English
                </h5>

                <div className="flex gap-2.5">
                  <span className="text-[10px] font-bold text-slate-600 font-mono mt-0.5 shrink-0">01</span>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {chosen.length === 0 ? (
                      <>A lead joins <span className="text-slate-200 font-semibold">only when you add it by hand</span>.</>
                    ) : (
                      <>
                        A lead joins when{' '}
                        {chosen.map((t, i) => (
                          <React.Fragment key={t.value}>
                            {i > 0 && (i === chosen.length - 1 ? ', or ' : ', ')}
                            <span className="text-slate-200 font-semibold">
                              {t.label.toLowerCase()}
                            </span>
                          </React.Fragment>
                        ))}
                        .
                      </>
                    )}
                  </p>
                </div>

                <div className="flex gap-2.5">
                  <span className="text-[10px] font-bold text-slate-600 font-mono mt-0.5 shrink-0">02</span>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    It then gets{' '}
                    <span className="text-slate-200 font-semibold">
                      {smsCount > 0 && `${smsCount} text${smsCount === 1 ? '' : 's'}`}
                      {smsCount > 0 && voiceCount > 0 && ' and '}
                      {voiceCount > 0 && `${voiceCount} AI call${voiceCount === 1 ? '' : 's'}`}
                    </span>{' '}
                    over <span className="text-slate-200 font-semibold">{daysLabel}</span>, the
                    first {formatDelay(steps[0]?.delayMinutes || 0)} after joining.
                  </p>
                </div>

                <div className="flex gap-2.5">
                  <span className="text-[10px] font-bold text-slate-600 font-mono mt-0.5 shrink-0">03</span>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {isActive ? (
                      <>
                        Sending is <span className="text-emerald-300 font-semibold">on</span>. Quiet
                        hours and do-not-contact still apply.
                      </>
                    ) : (
                      <>
                        Sending is <span className="text-slate-300 font-semibold">off</span>, so
                        nothing goes out and the conditions above are released.
                      </>
                    )}
                  </p>
                </div>
              </div>

              {/* Real counts, only where they exist. A brand new sequence has
                  none, and showing a zero would read as a measurement. */}
              {!isNew && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                      <Users className="w-4.5 h-4.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-slate-400">
                        Leads in this sequence
                      </div>
                      <div className="text-lg font-bold text-white leading-tight">
                        {sequence.activeCount}
                        <span className="text-[11px] font-normal text-slate-500 ml-1.5">
                          active
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-slate-500 shrink-0">
                    <div>{sequence.completedCount} completed</div>
                    <div>{sequence.stoppedCount} stopped</div>
                  </div>
                </div>
              )}
            </section>

            {/* ---- Right: what puts leads in it ---- */}
            <section className="lg:col-span-7 space-y-4">
              <div className={card}>
                <div className="border-b border-slate-800 pb-3 mb-4">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    Add leads automatically when…
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                    Nothing ticked means this sequence only ever takes leads you add by hand. Only
                    one active sequence can claim each condition.
                  </p>
                </div>

                {GROUPS.map((group) => {
                  const items = ENROLL_TRIGGERS.filter((t) => t.group === group.key);
                  return (
                    <div key={group.key} className="mb-5 last:mb-0">
                      <div className="flex items-center justify-between mb-2">
                        <h5 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${group.dot}`} />
                          {group.title}
                        </h5>
                        <span className="text-[10px] text-slate-500 font-medium">
                          {items.length} conditions
                        </span>
                      </div>

                      <div className="space-y-2">
                        {items.map((t) => {
                          const on = triggers.includes(t.value);
                          return (
                            <label
                              key={t.value}
                              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                                on
                                  ? 'bg-emerald-950/25 border-emerald-700/60'
                                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => toggle(t.value)}
                                className="mt-0.5 w-4 h-4 accent-emerald-500 shrink-0 cursor-pointer"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2 flex-wrap">
                                  <span
                                    className={`text-xs font-semibold ${
                                      on ? 'text-emerald-200' : 'text-slate-200'
                                    }`}
                                  >
                                    {t.label}
                                  </span>
                                  {t.badge && (
                                    <span
                                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border ${t.badge.className}`}
                                    >
                                      {t.badge.text}
                                    </span>
                                  )}
                                </span>
                                <span className="block text-[11px] text-slate-500 mt-0.5 leading-normal">
                                  {t.hint}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* The order is not cosmetic: a lead who never picked up satisfies
                  several of these at once, so saying which one wins is the
                  difference between a predictable setup and a surprising one. */}
              {triggers.filter((t) => !t.startsWith('qualified_')).length > 1 && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 flex items-start gap-2.5 text-[11px] text-slate-400">
                  <Info className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    <span className="text-slate-200 font-semibold">More than one can match.</span>{' '}
                    A lead who never picked up also never replied. The most specific condition
                    wins, in the order listed above — so
                    {' "'}finished the strategy without qualifying{'" '}
                    acts as the catch-all.
                  </p>
                </div>
              )}

              {/* Says what actually happens, which is a refusal rather than a
                  silent takeover: claiming a condition another active sequence
                  holds is rejected and names the holder. */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 flex items-start gap-2.5 text-[11px] text-slate-400">
                <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  <span className="text-slate-200 font-semibold">One sequence per condition.</span>{' '}
                  If another active sequence already claims one of these, saving is refused and
                  tells you which one — nothing is detached behind your back.
                </p>
              </div>
            </section>
          </div>

          {/* ---- Steps, full width ---- */}
          <div className={card}>
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
              <div>
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-emerald-400" />
                  Steps
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {steps.length} step{steps.length === 1 ? '' : 's'} over {daysLabel}.
                </p>
              </div>
              <button
                onClick={() => setSteps((p) => [...p, blankStep()])}
                className="px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-600/40 text-emerald-300 text-[11px] font-bold hover:bg-emerald-600/30 flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                Add step
              </button>
            </div>

            <div className="space-y-2">
              {steps.map((step, i) => (
                <div
                  key={i}
                  className="bg-slate-950/70 border border-slate-800/60 rounded-xl p-3 space-y-2"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-[10px] font-bold font-mono text-emerald-400 flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>

                    <select
                      className={`${input} w-auto`}
                      value={step.actionType}
                      onChange={(e) => patchStep(i, { actionType: e.target.value as ActionType })}
                    >
                      <option value="sms">SMS</option>
                      <option value="voice">AI callback</option>
                    </select>

                    <span className="text-[11px] text-slate-500">after</span>
                    <input
                      type="number"
                      min={1}
                      className={`${input} w-24`}
                      value={step.delayMinutes}
                      onChange={(e) => patchStep(i, { delayMinutes: Number(e.target.value) })}
                    />
                    <span className="text-[11px] text-slate-500">
                      min ({formatDelay(step.delayMinutes || 0)})
                    </span>

                    <span className="text-[11px] text-amber-400 ml-auto">
                      lands day {Math.round((cumulative[i] / DAY) * 10) / 10}
                    </span>

                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="text-slate-500 hover:text-slate-300 disabled:opacity-30 cursor-pointer"
                      aria-label="Move up"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === steps.length - 1}
                      className="text-slate-500 hover:text-slate-300 disabled:opacity-30 cursor-pointer"
                      aria-label="Move down"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setSteps((p) => p.filter((_, idx) => idx !== i))}
                      disabled={steps.length === 1}
                      className="text-rose-500 hover:text-rose-400 disabled:opacity-30 cursor-pointer"
                      aria-label="Remove step"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {step.actionType === 'sms' ? (
                    <div>
                      <textarea
                        className={`${input} h-16 resize-none`}
                        value={step.messageTemplate ?? ''}
                        onChange={(e) => patchStep(i, { messageTemplate: e.target.value })}
                        placeholder="Hi {{firstName}}, ..."
                      />
                      <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {'{{firstName}} and {{brokerage}} are substituted when it sends.'}
                        {i === 0 && ' Include "Reply STOP to opt out" on the first message.'}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <textarea
                        className={`${input} h-16 resize-none`}
                        value={step.voicePrompt ?? ''}
                        onChange={(e) => patchStep(i, { voicePrompt: e.target.value })}
                        placeholder="What should the AI try to find out on this call?"
                      />
                      <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                        <PhoneCall className="w-3 h-3" />
                        Guidance for the assistant on this callback.
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer. Sticky to the modal's own bottom so the save button stays
            reachable however long the step list grows. */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-3.5 border-t border-slate-800 bg-slate-950 rounded-b-2xl">
          <p className="text-[11px] text-slate-500 flex items-center gap-2 min-w-0">
            {dirty ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="truncate">
                  Unsaved changes
                  {!isNew && (
                    <span className="text-slate-300 font-semibold font-mono"> {sequence.code}</span>
                  )}
                </span>
              </>
            ) : (
              <span className="truncate">
                {steps.length} step{steps.length === 1 ? '' : 's'} over {daysLabel}
              </span>
            )}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !name.trim() || (isNew && !code.trim())}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer"
            >
              {saving ? 'Saving…' : isNew ? 'Create sequence' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

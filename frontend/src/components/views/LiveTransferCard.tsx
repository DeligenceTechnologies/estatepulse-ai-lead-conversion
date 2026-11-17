import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PhoneCall } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { Button } from '../common/Button';
import {
  LIVE_TRANSFER_LIMITS as L,
  getLiveTransfer,
  listCallTransfers,
  updateLiveTransfer,
  type AttemptStatus,
  type CallTransferRow,
  type LiveTransferSettings,
  type LiveTransferStatus,
  type TransferStatus,
} from '../../utils/liveTransferApi';

const TRANSFER_LABEL: Record<TransferStatus, { text: string; tone: string }> = {
  dialing: { text: 'Ringing agents', tone: 'text-sky-300' },
  connected: { text: 'Connected', tone: 'text-emerald-300' },
  no_agent: { text: 'No agent — AI took over', tone: 'text-amber-300' },
  abandoned: { text: 'Lead hung up', tone: 'text-slate-400' },
  failed: { text: 'Failed — AI took over', tone: 'text-rose-300' },
};

const ATTEMPT_LABEL: Record<AttemptStatus, string> = {
  dialing: 'ringing',
  answered: 'picked up',
  accepted: 'connected',
  declined: 'rejected',
  no_answer: 'no answer',
  busy: 'busy',
  voicemail: 'voicemail',
  failed: 'could not ring',
  cancelled: 'stopped',
};

const inRange = (n: number, r: { min: number; max: number }) => Number.isInteger(n) && n >= r.min && n <= r.max;
const numberField =
  'w-16 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50';

/**
 * Live transfer to an agent: the AI puts a ready lead's call through to an available agent while
 * the lead is still on the line, and books a meeting when no agent takes it.
 */
export const LiveTransferCard: React.FC = () => {
  const [status, setStatus] = useState<LiveTransferStatus | null>(null);
  const [timing, setTiming] = useState({ ringSeconds: 20, agentsPerTransfer: 2 });
  const [holdDraft, setHoldDraft] = useState('');
  const [recent, setRecent] = useState<CallTransferRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: LiveTransferStatus) => {
    setStatus(s);
    setTiming({ ringSeconds: s.ringSeconds, agentsPerTransfer: s.agentsPerTransfer });
    setHoldDraft(s.holdMessage);
  };

  useEffect(() => {
    getLiveTransfer()
      .then(apply)
      .catch((e) => setError(messageFor(e)));
    listCallTransfers()
      .then((rows) => setRecent(rows.slice(0, 10)))
      .catch(() => setRecent([]));
  }, []);

  const save = async (patch: Partial<LiveTransferSettings>, done: string) => {
    setBusy(true);
    try {
      apply(await updateLiveTransfer(patch));
      toast.success(done);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const on = !!status?.enabled;
  const timingValid = inRange(timing.ringSeconds, L.ringSeconds) && inRange(timing.agentsPerTransfer, L.agentsPerTransfer);
  const timingChanged =
    !!status && (timing.ringSeconds !== status.ringSeconds || timing.agentsPerTransfer !== status.agentsPerTransfer);
  const holdChanged = !!status && holdDraft.trim() !== status.holdMessage;
  const longestWait = timing.agentsPerTransfer * timing.ringSeconds;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-emerald-400" />
          Live transfer to an agent
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          When a lead on an AI call is ready to move (&ldquo;I&apos;m pre-approved for 600k, can I see it Saturday?&rdquo;) or asks
          for a person, the AI puts them on hold and rings an available agent: one who takes live transfers, covers the
          lead&apos;s area, is inside their working hours, not in a meeting and not on another call, taking turns so leads are
          shared fairly. As soon as the agent picks up, the lead is put straight through; a voicemail never gets the lead. If
          they don&apos;t answer, are busy or reject the call, the next agent is rung. If nobody takes it, the AI comes back and books a
          time with an agent through your calendar, or sets a callback when booking isn&apos;t available.
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          Agents opt in on Team (&ldquo;Live call transfers&rdquo;) with their phone number and the ZIP codes or cities they
          cover. The transfer tool rides with &ldquo;Callbacks and outcomes&rdquo;, which must be on.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {!status ? (
        !error && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        )
      ) : (
        <>
          {status.problem ? (
            <p className="text-[11px] text-amber-300 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {status.problem}
            </p>
          ) : (
            on && (
              <p className="text-xs flex items-center gap-1.5 text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                On — {status.agents.withPhone} agent{status.agents.withPhone === 1 ? '' : 's'} can take transfers.
              </p>
            )
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300 font-semibold cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={on}
              disabled={busy}
              onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'Live transfer is on.' : 'Live transfer is off.')}
              className="accent-emerald-500"
            />
            Put ready leads through to an agent during the call
          </label>

          <div className="text-xs space-y-1.5">
            <span className="block text-slate-300 font-semibold">Transfer when</span>
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={status.onHotLead}
                disabled={busy || !on}
                onChange={(e) => void save({ onHotLead: e.target.checked }, 'Saved.')}
                className="accent-emerald-500"
              />
              The lead is ready to move: pre-approved or a budget, and wants a showing or meeting soon
            </label>
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={status.onRequest}
                disabled={busy || !on}
                onChange={(e) => void save({ onRequest: e.target.checked }, 'Saved.')}
                className="accent-emerald-500"
              />
              The lead asks to speak to a person
            </label>
          </div>

          <div className="text-xs space-y-1.5">
            <span className="block text-slate-300 font-semibold">Ringing</span>
            <div className="flex flex-wrap items-center gap-2 text-slate-400">
              <span>Try up to</span>
              <input
                type="number"
                min={L.agentsPerTransfer.min}
                max={L.agentsPerTransfer.max}
                value={timing.agentsPerTransfer}
                disabled={busy || !on}
                onChange={(e) => setTiming({ ...timing, agentsPerTransfer: Number(e.target.value) })}
                aria-label="How many agents to try"
                className={numberField}
              />
              <span>agents, ringing each for</span>
              <input
                type="number"
                min={L.ringSeconds.min}
                max={L.ringSeconds.max}
                value={timing.ringSeconds}
                disabled={busy || !on}
                onChange={(e) => setTiming({ ...timing, ringSeconds: Number(e.target.value) })}
                aria-label="Seconds each agent's phone rings"
                className={numberField}
              />
              <span>seconds.</span>
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => void save(timing, 'Ringing saved.')}
                disabled={busy || !on || !timingChanged || !timingValid}
              >
                Save
              </Button>
            </div>
            {timingValid ? (
              <p className="text-[11px] text-slate-500">The lead holds for at most about {longestWait} seconds before the AI comes back.</p>
            ) : (
              <p className="text-[11px] text-rose-300">
                Use {L.agentsPerTransfer.min}–{L.agentsPerTransfer.max} agents, {L.ringSeconds.min}–{L.ringSeconds.max} seconds of ringing.
              </p>
            )}
          </div>

          <div className="text-xs space-y-1">
            <label className="block text-slate-300 font-semibold" htmlFor="live-transfer-hold">
              What the lead hears while agents are rung
            </label>
            <textarea
              id="live-transfer-hold"
              value={holdDraft}
              onChange={(e) => setHoldDraft(e.target.value.slice(0, L.holdMessage))}
              disabled={busy || !on}
              rows={2}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void save({ holdMessage: holdDraft.trim() }, 'Hold message saved.')} disabled={busy || !on || !holdChanged}>
                Save
              </Button>
              {holdDraft.trim() !== status.defaultHoldMessage && (
                <Button variant="outline" size="sm" onClick={() => void save({ holdMessage: '' }, 'Default hold message restored.')} disabled={busy || !on}>
                  Use the default
                </Button>
              )}
            </div>
          </div>

          {recent && recent.length > 0 && (
            <div className="text-xs space-y-1.5">
              <span className="block text-slate-300 font-semibold">Latest transfers</span>
              <ul className="divide-y divide-slate-800 border border-slate-800 rounded-lg">
                {recent.map((t) => (
                  <li key={t.id} className="px-3 py-2 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="text-white font-semibold">{t.leadName}</span>
                      <span className={TRANSFER_LABEL[t.status].tone}>{TRANSFER_LABEL[t.status].text}</span>
                      {t.fallback && <span className="text-slate-500">· offered a {t.fallback}</span>}
                      <span className="ml-auto text-slate-500">{new Date(t.startedAt).toLocaleString()}</span>
                    </div>
                    <div className="text-slate-400">
                      {t.attempts.length
                        ? t.attempts.map((a) => `${a.position}. ${a.agentName}: ${ATTEMPT_LABEL[a.status]}`).join('  ·  ')
                        : 'No agent was available.'}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
};

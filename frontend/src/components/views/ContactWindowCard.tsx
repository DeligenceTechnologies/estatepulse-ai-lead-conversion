import React, { useEffect, useState } from 'react';
import { Clock, Loader2, ShieldCheck } from 'lucide-react';
import { getStrategy, saveStrategy, type Guardrails } from '../../utils/strategiesApi';

/**
 * The contact window and safety limits, as one org-wide setting.
 *
 * Shown on both AI Settings and Follow-ups because both schedulers obey it —
 * the strategy engine asks "may I send right now?" and the nurture runner asks
 * "when may I next send?", and they read the same `strategy.guardrails`. An
 * office looking at its follow-up sequences has no way to know a quiet window
 * governs them unless it is in front of it, and one that edits it on either
 * page must be editing the same thing.
 *
 * This card writes the real column. Until it existed, the contact hours on AI
 * Settings were bound to the browser's demo store — the engine never read them,
 * so changing them appeared to work and did nothing at all.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Props {
  /** Why this setting is on THIS page, phrased for the page it is on. */
  blurb: string;
}

export const ContactWindowCard: React.FC<Props> = ({ blurb }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [respect, setRespect] = useState(true);
  const [start, setStart] = useState('21:00');
  const [end, setEnd] = useState('08:00');
  const [maxVoice, setMaxVoice] = useState(3);

  useEffect(() => {
    getStrategy()
      .then((s) => {
        const g: Guardrails = s.guardrails ?? {};
        setRespect(g.respectQuietHours !== false);
        if (g.quietHours?.start) setStart(g.quietHours.start);
        if (g.quietHours?.end) setEnd(g.quietHours.end);
        if (typeof g.maxVoiceAttempts === 'number') setMaxVoice(g.maxVoiceAttempts);
      })
      .catch((e) => setError(e?.message || 'Could not load your contact window.'))
      .finally(() => setLoading(false));
  }, []);

  const valid = HHMM.test(start) && HHMM.test(end);

  const save = async () => {
    if (!valid) {
      setError('Times must be in 24-hour HH:MM form, for example 21:00.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Read-modify-write: guardrails holds keys this card does not show
      // (stopOn, and anything added later), and a blind PUT would drop them.
      const current = await getStrategy();
      await saveStrategy({
        ...current,
        guardrails: {
          ...(current.guardrails ?? {}),
          respectQuietHours: respect,
          quietHours: { start, end },
          maxVoiceAttempts: maxVoice,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e?.message || 'Could not save your contact window.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-400" />
          Contact Window &amp; Safety Guardrails
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">{blurb}</p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading your contact window…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Quiet hours <span className="text-slate-500 font-normal">— nothing sends</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  disabled={!respect}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-32 text-center disabled:opacity-40 focus:outline-none focus:border-emerald-600"
                />
                <span className="text-slate-400">to</span>
                <input
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  disabled={!respect}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-32 text-center disabled:opacity-40 focus:outline-none focus:border-emerald-600"
                />
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                In your organization's timezone. A step falling inside this window is sent when it
                reopens, never dropped — and the rest of the cadence shifts with it.
              </p>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Max AI call attempts <span className="text-slate-500 font-normal">— per lead</span>
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={maxVoice}
                onChange={(e) => setMaxVoice(Number(e.target.value))}
                className="w-24 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Applies to the strategy's calls. Do-not-contact is absolute and is not a setting.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setRespect(!respect)}
            className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer"
          >
            <span
              className={`w-9 h-5 rounded-full relative shrink-0 transition-colors ${
                respect ? 'bg-emerald-600' : 'bg-rose-700'
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                  respect ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </span>
            <span className="font-semibold">
              {respect ? 'Quiet hours enforced' : 'Quiet hours OFF — messages may send at any hour'}
            </span>
          </button>

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-800">
            <p className="text-[11px] text-slate-500 flex items-center gap-1.5 min-w-0">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">
                One window for both the strategy and every follow-up sequence.
              </span>
            </p>
            <div className="flex items-center gap-2 shrink-0">
              {saved && <span className="text-[11px] text-emerald-400 font-semibold">Saved</span>}
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !valid}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer"
              >
                {saving ? 'Saving…' : 'Save window'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

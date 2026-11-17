import React, { useEffect, useState } from 'react';
import {
  CalendarOff,
  Clock,
  Gauge,
  Loader2,
  MessageSquare,
  Moon,
  PhoneCall,
  PhoneOff,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { DEFAULT_LIMITS, WEEKDAYS, type ContactLimits } from '../../utils/journey';
import { getStrategy, saveStrategy, type Guardrails } from '../../utils/strategiesApi';
import { Button } from '../common/Button';

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

const field =
  'bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-600 disabled:opacity-40';

/** One setting: an icon, a short name, the control and a one-line hint. */
const Tile: React.FC<{
  icon: React.ReactNode;
  title: string;
  hint: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ icon, title, hint, aside, className = '', children }) => (
  <div className={`bg-slate-950/50 border border-slate-800 rounded-xl p-4 flex flex-col gap-3 ${className}`}>
    <div className="flex items-center gap-2.5">
      <span className="w-7 h-7 rounded-lg bg-slate-500/10 border border-slate-500/20 text-slate-300 flex items-center justify-center shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">
        {icon}
      </span>
      <span className="text-xs font-bold text-slate-100 flex-1">{title}</span>
      {aside}
    </div>
    {children}
    <p className="text-2xs text-slate-400 leading-relaxed mt-auto">{hint}</p>
  </div>
);

/** A number box with its unit after it ("3 calls"). */
const NumberField: React.FC<{
  id?: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: string) => void;
}> = ({ id, value, min, max, unit, onChange }) => (
  <label className="flex items-center gap-2 text-xs text-slate-300">
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${field} w-20 text-center`}
    />
    {unit}
  </label>
);

interface Props {
  /** Why this setting is on THIS page, phrased for the page it is on. */
  blurb: string;
}

export const ContactWindowCard: React.FC<Props> = ({ blurb }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [respect, setRespect] = useState(true);
  const [start, setStart] = useState('21:00');
  const [end, setEnd] = useState('08:00');
  const [maxVoice, setMaxVoice] = useState(3);
  const [limits, setLimits] = useState<ContactLimits>(DEFAULT_LIMITS);
  const [skipDays, setSkipDays] = useState<number[]>([]);

  useEffect(() => {
    getStrategy()
      .then((s) => {
        const g: Guardrails = s.guardrails ?? {};
        setRespect(g.respectQuietHours !== false);
        if (g.quietHours?.start) setStart(g.quietHours.start);
        if (g.quietHours?.end) setEnd(g.quietHours.end);
        if (typeof g.maxVoiceAttempts === 'number') setMaxVoice(g.maxVoiceAttempts);
        if (g.limits) setLimits({ ...DEFAULT_LIMITS, ...g.limits });
        if (Array.isArray(g.skipDays)) setSkipDays(g.skipDays);
      })
      .catch((e) => setError(e?.message || 'Could not load your contact settings.'))
      .finally(() => setLoading(false));
  }, []);

  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  const valid =
    HHMM.test(start) &&
    HHMM.test(end) &&
    whole(limits.callsPerDay, 20) &&
    whole(limits.smsPerDay, 20) &&
    whole(limits.minGapMinutes, 1440) &&
    whole(limits.redialGapMinutes, 1440) &&
    whole(limits.chatQuietMinutes, 1440) &&
    skipDays.length < 7;
  const setLimit = (key: keyof ContactLimits, value: string) => setLimits((l) => ({ ...l, [key]: value === '' ? 0 : Number(value) }));
  const toggleDay = (d: number) => setSkipDays((days) => (days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort()));

  const save = async () => {
    if (!valid) {
      setError(
        'Check the values: limits are whole numbers (up to 20 a day, waits up to 1440 min) and at least one day must stay open.',
      );
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
          limits,
          skipDays,
        },
      });
      toast.success('Contact settings saved.');
    } catch (e: any) {
      toast.error(e?.message || 'Could not save your contact settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
          <Clock className="w-4 h-4 text-amber-400" />
        </span>
        <div>
          <h3 className="text-sm font-bold text-white">Contact hours &amp; limits</h3>
          <p className="text-xs text-slate-400 mt-0.5">{blurb}</p>
        </div>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-3">
            <Tile
              className="lg:col-span-3"
              icon={<Moon />}
              title="Quiet hours"
              hint="In the lead's local time. Anything due now waits until morning; nothing is skipped."
              aside={
                <button
                  type="button"
                  role="switch"
                  aria-checked={respect}
                  aria-label="Quiet hours on"
                  onClick={() => setRespect(!respect)}
                  className="flex items-center gap-2 text-2xs font-semibold cursor-pointer"
                >
                  <span className={respect ? 'text-green-300' : 'text-rose-300'}>{respect ? 'On' : 'Off'}</span>
                  <span
                    className={`w-9 h-5 rounded-full relative shrink-0 transition-colors ${respect ? 'bg-emerald-600' : 'bg-slate-700'}`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent shadow transition-all ${
                        respect ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </span>
                </button>
              }
            >
              <div className="flex items-center gap-2 flex-wrap text-xs text-slate-300">
                <span>No contact from</span>
                <input
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  disabled={!respect}
                  aria-label="Quiet hours start"
                  className={`${field} w-32 text-center`}
                />
                <span>to</span>
                <input
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  disabled={!respect}
                  aria-label="Quiet hours end"
                  className={`${field} w-32 text-center`}
                />
              </div>
              {!respect && (
                <p className="text-2xs font-semibold text-rose-300">Off: texts and calls can go out at any hour.</p>
              )}
            </Tile>

            <Tile
              className="lg:col-span-3"
              icon={<CalendarOff />}
              title="Days off"
              hint="Tap a day to turn it off. Steps move to the next open day."
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                {WEEKDAYS.map((day, d) => {
                  const off = skipDays.includes(d);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={off}
                      onClick={() => toggleDay(d)}
                      className={`w-11 py-1.5 rounded-lg border text-2xs font-semibold cursor-pointer transition-colors ${
                        off
                          ? 'border-rose-500/30 bg-rose-500/10 text-rose-300 line-through'
                          : 'border-green-500/25 bg-green-500/10 text-green-300 hover:border-green-500/40'
                      }`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </Tile>

            <Tile className="lg:col-span-2" icon={<Gauge />} title="Daily limit per lead" hint="0 means no limit.">
              <div className="flex items-center gap-4 flex-wrap">
                <NumberField value={limits.callsPerDay} min={0} max={20} unit="calls" onChange={(v) => setLimit('callsPerDay', v)} />
                <NumberField value={limits.smsPerDay} min={0} max={20} unit="texts" onChange={(v) => setLimit('smsPerDay', v)} />
              </div>
            </Tile>

            <Tile
              className="lg:col-span-2"
              icon={<Timer />}
              title="Gap between messages"
              hint="Between two calls or two texts to the same lead."
            >
              <NumberField value={limits.minGapMinutes} min={0} max={1440} unit="min" onChange={(v) => setLimit('minGapMinutes', v)} />
            </Tile>

            <Tile className="lg:col-span-2" icon={<PhoneCall />} title="Max AI call attempts" hint="Per lead, in total.">
              <NumberField value={maxVoice} min={1} max={10} unit="calls" onChange={(v) => setMaxVoice(Number(v))} />
            </Tile>

            <Tile
              className="lg:col-span-3"
              icon={<PhoneOff />}
              title="After a declined call"
              hint="Wait before calling again. Callbacks the lead asked for are not delayed."
            >
              <NumberField
                id="redial-gap"
                value={limits.redialGapMinutes}
                min={0}
                max={1440}
                unit="min"
                onChange={(v) => setLimit('redialGapMinutes', v)}
              />
            </Tile>

            <Tile
              className="lg:col-span-3"
              icon={<MessageSquare />}
              title="While a lead is texting"
              hint="Wait after their last text, so a step never interrupts a chat."
            >
              <NumberField
                id="chat-quiet"
                value={limits.chatQuietMinutes}
                min={0}
                max={1440}
                unit="min"
                onChange={(v) => setLimit('chatQuietMinutes', v)}
              />
            </Tile>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800">
            <p className="text-xs text-slate-400 flex items-center gap-1.5 min-w-0">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              Legal calling hours and do-not-contact always apply.
            </p>
            <Button size="sm" onClick={() => void save()} disabled={!valid} loading={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

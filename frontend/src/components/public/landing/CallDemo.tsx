import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { Check, UserCheck } from 'lucide-react';

type Field = 'area' | 'budget' | 'type' | 'timeline';
interface Line {
  who: 'ai' | 'lead';
  text: string;
  fills?: [Field, string];
}

/** A scripted example call. Labelled as an example on the page; no real lead. */
const SCRIPT: Line[] = [
  { who: 'ai', text: 'Hi Aditya, this is the assistant from Sunny’s team. You asked about homes in Austin. Is now a good time?' },
  { who: 'lead', text: 'Yes, go ahead.' },
  { who: 'ai', text: 'Which areas or neighbourhoods are you considering?' },
  { who: 'lead', text: 'I’m looking in Austin, ideally north.', fills: ['area', 'North Austin'] },
  { who: 'ai', text: 'Nice. What budget range are you working with?' },
  { who: 'lead', text: 'Around $600K to $700K.', fills: ['budget', '$600–700K'] },
  { who: 'ai', text: 'And what kind of home? How many bedrooms?' },
  { who: 'lead', text: 'Single-family, four bedrooms.', fills: ['type', '4 bed · single-family'] },
  { who: 'ai', text: 'When are you hoping to move?' },
  { who: 'lead', text: 'In two to three months.', fills: ['timeline', '2–3 months'] },
  { who: 'ai', text: 'Great. I have Tuesday at 10:30 for a buyer consultation. Shall I book it?' },
  { who: 'lead', text: 'Tuesday works.' },
];

const FIELDS: Array<[Field, string]> = [
  ['area', 'Area'],
  ['budget', 'Budget'],
  ['type', 'Looking for'],
  ['timeline', 'Timeline'],
];

const TYPING_MS = 750;
const AI_READ_MS = 1250;
const LEAD_READ_MS = 950;
const LOOP_PAUSE_MS = 4500;

export const CallDemo: React.FC = () => {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const [shown, setShown] = useState(reduce ? SCRIPT.length : 0);
  const [typing, setTyping] = useState(false);
  const [run, setRun] = useState(0);

  // Plays the script while the phone is on screen; resets when it leaves.
  useEffect(() => {
    if (reduce) return;
    if (!inView) {
      setShown(0);
      setTyping(false);
      return;
    }
    const timers: number[] = [];
    let t = 300;
    SCRIPT.forEach((line, i) => {
      if (line.who === 'ai') {
        timers.push(window.setTimeout(() => setTyping(true), t));
        t += TYPING_MS;
      }
      timers.push(
        window.setTimeout(() => {
          setTyping(false);
          setShown(i + 1);
        }, t),
      );
      t += line.who === 'ai' ? AI_READ_MS : LEAD_READ_MS;
    });
    timers.push(
      window.setTimeout(() => {
        setShown(0);
        setRun((r) => r + 1);
      }, t + LOOP_PAUSE_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [inView, reduce, run]);

  const visible = SCRIPT.slice(0, shown);
  const filled = new Map(visible.filter((l) => l.fills).map((l) => l.fills!));
  const done = shown === SCRIPT.length;

  return (
    <div ref={ref} className="lp-phone">
      <div className="lp-phone-top">
        <div className="lp-row">
          <span className="lp-avatar">AR</span>
          <div>
            <div style={{ fontWeight: 600 }}>Aditya Rao</div>
            <div style={{ fontSize: 12, color: 'var(--surface-muted)' }}>Outbound AI call · example</div>
          </div>
        </div>
        <span className="lp-live">LIVE</span>
      </div>

      <div className="lp-msgs" aria-live="off">
        {(reduce ? visible.slice(-4) : visible).map((line, i) => (
          <motion.div
            key={`${run}-${i}`}
            className={`lp-msg ${line.who}`}
            initial={reduce ? false : { opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          >
            <span className="who">{line.who === 'ai' ? 'AI assistant' : 'Aditya'}</span>
            {line.text}
          </motion.div>
        ))}
        {typing && (
          <div className="lp-typing" aria-hidden>
            <i />
            <i />
            <i />
          </div>
        )}
      </div>

      <div className="lp-record">
        {FIELDS.map(([key, label]) => (
          <div key={key} className={`lp-field ${filled.has(key) ? 'is-filled' : ''}`}>
            <div className="fk">{label}</div>
            <div className="fv">{filled.get(key) ?? ''}</div>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {done && (
          <motion.div
            className="lp-assigned"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <UserCheck />
            <span>
              <b>Assigned to Priya</b> · covers North Austin
            </span>
            <Check style={{ marginLeft: 'auto' }} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

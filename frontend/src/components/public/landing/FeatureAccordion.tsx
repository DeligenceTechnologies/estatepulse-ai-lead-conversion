import React, { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  motion,
  useAnimate,
  useInView,
  useMotionValue,
  useReducedMotion,
} from 'motion/react';
import { Plus } from 'lucide-react';
import { ClipVideo } from './ClipVideo';
import type { ClipName } from './clips';

const FEATURES: Array<{ clip: ClipName; name: string; path: string; text: string; peek: [string, string] }> = [
  {
    clip: 'intake',
    name: 'Capture',
    path: '/leads',
    text: 'Leads land the moment they’re submitted. Connect Google Forms, Sheets, HubSpot, Airtable or a webhook, and each new lead shows up live, tagged with where it came from.',
    peek: ['Source', 'Website form · just now'],
  },
  {
    clip: 'ai-call',
    name: 'Qualify on a call',
    path: '/calls',
    text: 'An AI voice call asks what a good agent would: area, budget, timeline, property type and financing. The answers fill the lead record as the call happens.',
    peek: ['Budget', '$600K – $700K'],
  },
  {
    clip: 'followups',
    name: 'Follow up',
    path: '/followups',
    text: 'A sequence you design: a text right away, a call a minute later, another text if there’s no answer. You choose the steps and the timing.',
    peek: ['Sequence', 'Text → Call → Text'],
  },
  {
    clip: 'conversations',
    name: 'Keep the conversation',
    path: '/conversations',
    text: 'When a lead texts back, the AI replies in the same thread and moves toward a meeting. An agent can take over at any time.',
    peek: ['SMS', 'Consultation offered'],
  },
  {
    clip: 'scheduling',
    name: 'Book the meeting',
    path: '/appointments',
    text: 'The AI checks your Calendly for a free slot and books the consultation. The meeting syncs straight onto the lead.',
    peek: ['Booked', 'Tue · 10:30 AM'],
  },
  {
    clip: 'routing',
    name: 'Route to the right agent',
    path: '/leads',
    text: 'Leads go to the agent who covers that area and has room to take them. Reassign in one click when plans change.',
    peek: ['Assigned', 'Priya · North Austin'],
  },
];

/** How long an item stays open when its clip is missing or won't play. */
const FALLBACK_MS = 8000;

/**
 * Accordion of features beside one product clip. Opening an item pops its clip
 * in (scale + tilt), drifts the colour shapes behind it and slides a detail
 * card over the corner. Items advance when the clip ends.
 */
export const FeatureAccordion: React.FC = () => {
  const [active, setActive] = useState(0);
  const [restart, setRestart] = useState(0);
  const [clipMissing, setClipMissing] = useState(false);
  const progress = useMotionValue(0);
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { margin: '-80px' });
  const [frameScope, animateFrame] = useAnimate<HTMLDivElement>();
  const firstRender = useRef(true);

  const feature = FEATURES[active];

  const select = (i: number) => {
    if (i === active) setRestart((r) => r + 1);
    setActive(i);
    setClipMissing(false);
    progress.set(0);
  };
  const advance = () => select((active + 1) % FEATURES.length);

  // Pop the frame in whenever the active item changes.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (reduce || !frameScope.current) return;
    animateFrame(
      frameScope.current,
      { scale: [0.94, 1], rotateX: [8, 0], opacity: [0.35, 1] },
      { duration: 0.45, ease: [0.2, 1.1, 0.35, 1] },
    );
  }, [active, restart, reduce, animateFrame, frameScope]);

  // Timer-driven progress when there is no clip to drive it.
  useEffect(() => {
    if (!clipMissing || !inView) return;
    const start = performance.now() - progress.get() * FALLBACK_MS;
    let raf = 0;
    const tick = (now: number) => {
      const p = (now - start) / FALLBACK_MS;
      if (p >= 1) return advance();
      progress.set(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipMissing, inView, active, restart]);

  return (
    <div ref={rootRef} className="lp-feat-grid">
      <div className="lp-acc">
        {FEATURES.map((f, i) => {
          const open = i === active;
          return (
            <div key={f.name} className={`lp-acc-item ${open ? 'is-open' : ''}`}>
              <button
                type="button"
                className="lp-acc-btn"
                id={`lp-acc-${i}`}
                aria-expanded={open}
                aria-controls={`lp-acc-panel-${i}`}
                onClick={() => select(i)}
              >
                <span className="num">0{i + 1}</span>
                <span className="name">{f.name}</span>
                <span className="lp-pm">
                  <Plus />
                </span>
              </button>
              <div className="lp-acc-body" id={`lp-acc-panel-${i}`} role="region" aria-labelledby={`lp-acc-${i}`}>
                <div>
                  <p>{f.text}</p>
                  <div className="lp-acc-prog">
                    {open && <motion.i style={{ scaleX: progress }} />}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="lp-showcase">
        <motion.div
          className="lp-shape s1"
          animate={{ x: active % 2 ? -18 : 12, y: (active % 3) * 12 - 12, scale: 1 + (active % 3) * 0.06 }}
          transition={{ type: 'spring', stiffness: 60, damping: 16 }}
        />
        <motion.div
          className="lp-shape s2"
          animate={{ x: active % 2 ? 18 : -8, y: active * -6, scale: 1 + ((active + 1) % 3) * 0.08 }}
          transition={{ type: 'spring', stiffness: 60, damping: 16 }}
        />
        <div ref={frameScope} className="lp-frame">
          <div className="lp-frame-bar">
            <i />
            <i />
            <i />
            <span className="url">app.estatepulse.ai{feature.path}</span>
          </div>
          <ClipVideo
            name={feature.clip}
            label={`${feature.name} — product clip`}
            loop={false}
            playKey={`${active}-${restart}`}
            onProgress={(p) => progress.set(p)}
            onEnded={advance}
            onUnavailable={() => setClipMissing(true)}
            className="lp-clip"
          />
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={active}
            className="lp-peek"
            initial={reduce ? false : { opacity: 0, x: 18, y: 14, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={{ delay: 0.15, type: 'spring', stiffness: 300, damping: 22 }}
          >
            <div className="lp-k">{feature.peek[0]}</div>
            <div className="v">{feature.peek[1]}</div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

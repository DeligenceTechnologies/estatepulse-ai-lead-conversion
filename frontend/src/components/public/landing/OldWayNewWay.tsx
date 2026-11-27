import React, { useEffect, useRef, useState } from 'react';
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { AlertTriangle, CalendarCheck, CheckCircle2, FileText, PhoneCall, UserCheck } from 'lucide-react';

const CARDS = [
  {
    old: ['Form lands in a shared inbox', 'Nobody owns it yet.'],
    neu: ['Lead arrives', 'Live, tagged with its source.'],
    Icon: FileText,
  },
  {
    old: ['Someone calls back tomorrow', 'If they remember.'],
    neu: ['AI calls right away', 'Inside your contact hours.'],
    Icon: PhoneCall,
  },
  {
    old: ['Budget? Timeline? Nobody asked', 'Notes in a spreadsheet.'],
    neu: ['Qualified', 'Answers saved on the lead.'],
    Icon: CheckCircle2,
  },
  {
    old: ['Back-and-forth to find a time', 'Three texts, no meeting.'],
    neu: ['Meeting booked', 'From your real calendar.'],
    Icon: CalendarCheck,
  },
  {
    old: ['Who is handling this lead?', 'Two agents call, or none.'],
    neu: ['Right agent assigned', 'By area and capacity.'],
    Icon: UserCheck,
  },
];

// Where each card starts, scattered and tilted.
const SCATTER_WIDE = [
  { x: -340, y: -110, r: -9 },
  { x: 250, y: -130, r: 7 },
  { x: -60, y: 20, r: -4 },
  { x: 330, y: 90, r: 10 },
  { x: -300, y: 120, r: 5 },
];
const SCATTER_NARROW = [
  { x: -70, y: -210, r: -8 },
  { x: 60, y: -110, r: 7 },
  { x: -50, y: -10, r: -4 },
  { x: 65, y: 95, r: 9 },
  { x: -45, y: 200, r: 5 },
];

const PainCard: React.FC<{
  index: number;
  t: MotionValue<number>;
  narrow: boolean;
  gap: number;
  card: (typeof CARDS)[number];
}> = ({ index, t, narrow, gap, card }) => {
  const s = (narrow ? SCATTER_NARROW : SCATTER_WIDE)[index];
  const tx = narrow ? 0 : (index - 2) * gap;
  const ty = narrow ? (index - 2) * 94 : 0;
  const x = useTransform(t, (v) => s.x + (tx - s.x) * v);
  const y = useTransform(t, (v) => s.y + (ty - s.y) * v);
  const rotate = useTransform(t, (v) => s.r * (1 - v));
  // Cards flip one after another as they settle into the row.
  const start = 0.45 + index * 0.06;
  const newOpacity = useTransform(t, [start, start + 0.2], [0, 1]);
  const oldOpacity = useTransform(newOpacity, (v) => 1 - v);
  const { Icon } = card;

  return (
    <motion.div className="lp-pcard" style={{ x, y, rotate }}>
      <motion.div className="lp-face old" style={{ opacity: oldOpacity }}>
        <AlertTriangle />
        <div className="lp-ft">{card.old[0]}</div>
        {!narrow && <div className="lp-fs">{card.old[1]}</div>}
      </motion.div>
      <motion.div className="lp-face new" style={{ opacity: newOpacity }} aria-hidden>
        <span className="lp-step">0{index + 1}</span>
        <Icon />
        <div className="lp-ft">{card.neu[0]}</div>
        {!narrow && <div className="lp-fs">{card.neu[1]}</div>}
      </motion.div>
    </motion.div>
  );
};

/**
 * Sticky scroll section: scattered "old way" problems slide into one ordered
 * flow and flip to show the EstatePulse step. Scroll drives motion values
 * directly — no re-renders or layout reads per frame.
 */
export const OldWayNewWay: React.FC = () => {
  const reduce = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(1100);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoardWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start start', 'end end'] });
  const t = useTransform(scrollYProgress, (p) => {
    if (reduce) return p > 0.35 ? 1 : 0;
    const v = Math.min(1, Math.max(0, (p - 0.08) / 0.7));
    return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
  });

  const oldHeadOpacity = useTransform(t, [0, 0.45], [1, 0]);
  const oldHeadY = useTransform(t, [0, 0.45], [0, -20]);
  const newHeadOpacity = useTransform(t, [0.55, 1], [0, 1]);
  const newHeadY = useTransform(t, [0.55, 1], [20, 0]);
  const lineScale = useTransform(t, [0.75, 1], [0, 1]);
  const footOpacity = useTransform(t, [0, 0.3], [1, 0]);

  const narrow = boardWidth <= 760;
  const gap = Math.min(220, (boardWidth - 40) / 5);

  return (
    <section ref={sectionRef} className="lp-shift" id="how-it-works" aria-label="Before and after EstatePulse">
      <div className="lp-shift-sticky">
        <div className="lp-wrap">
          <div className="lp-shift-head">
            <motion.div className="old" style={{ opacity: oldHeadOpacity, y: oldHeadY }}>
              <span className="lp-eyebrow">Without EstatePulse</span>
              <h2 className="lp-h2">Leads wait. Then they go quiet.</h2>
            </motion.div>
            <motion.div style={{ opacity: newHeadOpacity, y: newHeadY }}>
              <span className="lp-eyebrow">With EstatePulse</span>
              <h2 className="lp-h2">
                One flow. <span className="lp-accent-line" style={{ display: 'inline' }}>Minutes, not days.</span>
              </h2>
            </motion.div>
          </div>
          <div className="lp-board" ref={boardRef}>
            <motion.div className="lp-flowline" style={{ scaleX: lineScale }} />
            {CARDS.map((card, i) => (
              // Remount on layout change so each card's scroll mapping uses the new targets.
              <PainCard key={`${i}-${narrow}-${Math.round(gap)}`} index={i} t={t} narrow={narrow} gap={gap} card={card} />
            ))}
          </div>
          <motion.p className="lp-shift-foot" style={{ opacity: footOpacity }}>
            Scroll to bring it together ↓
          </motion.p>
        </div>
      </div>
    </section>
  );
};

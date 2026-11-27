import React, { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { ArrowRight, Check, UserCheck } from 'lucide-react';
import { usePauseOffscreen } from './useLandingLook';

/**
 * Floating card that drifts against the pointer. `depth` is how far (px) it
 * moves at the screen edge; springs keep the motion smooth with no lag.
 */
const FloatCard: React.FC<{
  depth: number;
  rotate: number;
  delay: number;
  className: string;
  px: MotionValue<number>;
  py: MotionValue<number>;
  children: React.ReactNode;
}> = ({ depth, rotate, delay, className, px, py, children }) => {
  const x = useTransform(px, (v) => -v * depth);
  const y = useTransform(py, (v) => -v * depth);
  return (
    <motion.div className={`lp-fcard ${className}`} style={{ x, y, rotate }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.88, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ delay, type: 'spring', stiffness: 260, damping: 22 }}
      >
        <div className="lp-fcard-body lp-float" style={{ animationDelay: `${-delay * 3}s` }}>
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
};

export const Hero: React.FC = () => {
  const reduce = useReducedMotion();
  const { ref, pausedClass } = usePauseOffscreen<HTMLElement>();

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const px = useSpring(mx, { stiffness: 120, damping: 20, mass: 0.5 });
  const py = useSpring(my, { stiffness: 120, damping: 20, mass: 0.5 });
  const orbX = useTransform(px, (v) => -v * 8);
  const orbY = useTransform(py, (v) => -v * 8);

  useEffect(() => {
    if (reduce || !window.matchMedia('(pointer: fine)').matches) return;
    const onMove = (e: PointerEvent) => {
      mx.set(e.clientX / window.innerWidth - 0.5);
      my.set(e.clientY / window.innerHeight - 0.5);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reduce, mx, my]);

  // Fixed per mount so the bars don't reshuffle on re-render.
  const bars = useMemo(
    () => Array.from({ length: 26 }, () => ({ delay: -Math.random() * 1.1, dur: 0.8 + Math.random() * 0.6 })),
    [],
  );

  return (
    <section ref={ref} className={`lp-hero ${pausedClass}`}>
      <div className="lp-wrap lp-hero-grid">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow lp-load">AI lead conversion for real estate teams</span>
          <h1 className="lp-display lp-load d1">
            Every inbound lead gets a call.
            <span className="lp-accent-line">Before it goes cold.</span>
          </h1>
          <p className="lp-lede lp-load d2">
            EstatePulse calls new leads with an AI voice agent, finds out what they actually want, books the
            meeting and hands the serious ones to the agent who covers that area.
          </p>
          <div className="lp-load d3">
            <Link className="lp-btn lp-btn-primary" to="/signup">
              Create your organization <ArrowRight />
            </Link>
          </div>
          <div className="lp-hero-note lp-load d4">
            <span className="lp-dot" />
            Works with the forms your leads already use.
          </div>
        </div>

        <div className="lp-stage" aria-label="Example of one lead moving through EstatePulse">
          <motion.div className="lp-orb-wrap" style={{ x: orbX, y: orbY }}>
            <div className="lp-orb" />
          </motion.div>

          <FloatCard className="lp-c1" depth={22} rotate={-3} delay={0.25} px={px} py={py}>
            <div className="lp-k">
              <span>New lead · Website form</span>
              <span>now</span>
            </div>
            <div className="lp-row" style={{ marginTop: 10 }}>
              <span className="lp-avatar">AR</span>
              <div>
                <div className="lp-t" style={{ margin: 0 }}>Aditya Rao</div>
                <div className="lp-s">Buyer · Austin</div>
              </div>
            </div>
          </FloatCard>

          <FloatCard className="lp-c2" depth={34} rotate={3} delay={0.4} px={px} py={py}>
            <div className="lp-k">
              <span>AI calling</span>
              <span>00:42</span>
            </div>
            <div className="lp-t">“Which areas are you considering?”</div>
            <div className="lp-wave" aria-hidden>
              {bars.map((b, i) => (
                <i key={i} style={{ animationDelay: `${b.delay.toFixed(2)}s`, animationDuration: `${b.dur.toFixed(2)}s` }} />
              ))}
            </div>
          </FloatCard>

          <FloatCard className="lp-c3" depth={28} rotate={2} delay={0.55} px={px} py={py}>
            <div className="lp-k">
              <span>Qualified on the call</span>
            </div>
            <div className="lp-chips">
              <span className="lp-chip">$600–700K</span>
              <span className="lp-chip">4 bed · single-family</span>
              <span className="lp-chip">Pre-approved</span>
              <span className="lp-chip">2–3 months</span>
            </div>
          </FloatCard>

          <FloatCard className="lp-c4" depth={40} rotate={-2} delay={0.7} px={px} py={py}>
            <div className="lp-k">
              <span>Calendly</span>
            </div>
            <div className="lp-t">Buyer consultation</div>
            <div className="lp-s">Tue · 10:30 AM</div>
            <div className="lp-status">
              <Check />
              Booked during the call
            </div>
          </FloatCard>

          <FloatCard className="lp-c5" depth={18} rotate={-1} delay={0.85} px={px} py={py}>
            <div className="lp-row">
              <UserCheck style={{ width: 18, height: 18, color: 'var(--accent)', flex: 'none' }} />
              <div>
                <div className="lp-t" style={{ margin: 0 }}>Assigned to Priya</div>
                <div className="lp-s">Covers North Austin · has capacity</div>
              </div>
            </div>
          </FloatCard>

          <span className="lp-example-tag">Example lead</span>
        </div>
      </div>
    </section>
  );
};

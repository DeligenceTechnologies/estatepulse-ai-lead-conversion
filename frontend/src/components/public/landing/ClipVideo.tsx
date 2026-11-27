import React, { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { clipSources, type ClipName } from './clips';

interface ClipVideoProps {
  name: ClipName;
  /** Human label, used for aria and the placeholder shown when the file is missing. */
  label: string;
  /** Loop forever (default). FeatureAccordion turns this off so it can advance on `ended`. */
  loop?: boolean;
  /** Restart from 0 whenever this changes — used when a tab is re-selected. */
  playKey?: number | string;
  onProgress?: (fraction: number) => void;
  onEnded?: () => void;
  /** Called once if the clip can't be loaded, so callers can fall back to a timer. */
  onUnavailable?: () => void;
  className?: string;
}

/**
 * A short, muted product clip in the style of a marketing site:
 * - nothing is requested until the clip is near the viewport;
 * - it plays only while on screen and pauses when scrolled away;
 * - with reduced motion it shows the poster frame and never plays;
 * - a missing file renders a quiet placeholder instead of a broken player.
 */
export const ClipVideo: React.FC<ClipVideoProps> = ({
  name,
  label,
  loop = true,
  playKey,
  onProgress,
  onEnded,
  onUnavailable,
  className = '',
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const reduceMotion = useReducedMotion();
  const src = clipSources(name);

  // Two observers: a wide one to start loading early, a tight one to play/pause.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const loadObs = new IntersectionObserver(
      ([e]) => e.isIntersecting && setNear(true),
      { rootMargin: '400px 0px' },
    );
    // Low threshold: the hero clip is only partly above the fold on load and
    // should already be moving there.
    const playObs = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
      threshold: 0.15,
    });
    loadObs.observe(el);
    playObs.observe(el);
    return () => {
      loadObs.disconnect();
      playObs.disconnect();
    };
  }, [failed]);

  // A new name means new <source> children; the element must be told to reload.
  useEffect(() => {
    setFailed(false);
    if (near) ref.current?.load();
  }, [name, near]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !near || failed) return;
    if (visible && !reduceMotion) {
      el.play().catch(() => {
        /* autoplay refused — the poster stays, which is fine */
      });
    } else {
      el.pause();
    }
  }, [visible, near, failed, reduceMotion, name]);

  useEffect(() => {
    const el = ref.current;
    if (!el || playKey === undefined) return;
    el.currentTime = 0;
    onProgress?.(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey]);

  const markFailed = () => {
    if (failed) return;
    setFailed(true);
    onUnavailable?.();
  };

  if (failed) {
    return (
      <div
        role="img"
        aria-label={label}
        className={`relative flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/60 text-slate-500 ${className}`}
      >
        <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(var(--color-slate-400)_1px,transparent_1px),linear-gradient(90deg,var(--color-slate-400)_1px,transparent_1px)] [background-size:28px_28px]" />
        <Film className="w-6 h-6 text-emerald-500/60" />
        <span className="relative text-xs font-semibold">{label}</span>
      </div>
    );
  }

  return (
    <video
      ref={ref}
      aria-label={label}
      className={`block bg-slate-900 object-cover ${className}`}
      poster={src.poster}
      muted
      playsInline
      loop={loop}
      preload={near ? 'auto' : 'none'}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (onProgress && v.duration) onProgress(v.currentTime / v.duration);
      }}
      onEnded={onEnded}
      onError={markFailed}
    >
      {near && (
        <>
          <source src={src.webm} type="video/webm" />
          {/* The last <source> erroring means every format failed. */}
          <source src={src.mp4} type="video/mp4" onError={markFailed} />
        </>
      )}
    </video>
  );
};

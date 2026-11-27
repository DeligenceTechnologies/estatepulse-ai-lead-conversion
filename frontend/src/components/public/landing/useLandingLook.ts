import { useCallback, useEffect, useRef, useState } from 'react';
import { useInView } from 'motion/react';

/** The home page's two colour sets; tokens live in landing.css under `.lp[data-look]`. */
export type LandingLook = 'midnight' | 'beige';

const KEY = 'ep_landing_look';
/** Page background per look, mirrored onto <body> so overscroll matches. */
const PAGE_BG: Record<LandingLook, string> = { midnight: '#07080b', beige: '#f1f0eb' };

function readSaved(): LandingLook {
  try {
    return localStorage.getItem(KEY) === 'beige' ? 'beige' : 'midnight';
  } catch {
    return 'midnight';
  }
}

/** Midnight by default; the visitor's choice is remembered on this device. */
export function useLandingLook() {
  const [look, setLook] = useState<LandingLook>(readSaved);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, look);
    } catch {
      /* storage blocked — the toggle still works for this visit */
    }
    const body = document.body.style;
    const previous = body.backgroundColor;
    body.backgroundColor = PAGE_BG[look];
    return () => {
      body.backgroundColor = previous;
    };
  }, [look]);

  const toggle = useCallback(() => setLook((l) => (l === 'midnight' ? 'beige' : 'midnight')), []);
  return { look, toggle };
}

/**
 * Ref + class name that pauses a section's CSS animations while it is off
 * screen, so loops (orb, waveform, marquee) cost nothing when not visible.
 */
export function usePauseOffscreen<T extends Element>() {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { margin: '120px 0px' });
  return { ref, pausedClass: inView ? '' : 'lp-paused' };
}

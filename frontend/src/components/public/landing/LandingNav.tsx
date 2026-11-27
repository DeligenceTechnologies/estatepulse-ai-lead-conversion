import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Moon, Sun, Zap } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import type { LandingLook } from './useLandingLook';

/**
 * Section links carry the `/` so they work from /terms and /privacy too; the
 * home page scrolls to the hash itself.
 */
export const NAV_LINKS = [
  { to: '/#product', label: 'Product' },
  { to: '/#how-it-works', label: 'How it works' },
  { to: '/#faq', label: 'FAQ' },
  { to: '/terms', label: 'Terms & Conditions' },
];

export const Brand: React.FC = () => (
  <Link className="lp-brand" to="/#top">
    <span className="lp-brand-mark">
      <Zap />
    </span>
    <span>
      EstatePulse<span className="lp-ai">&nbsp;AI</span>
    </span>
  </Link>
);

interface Props {
  look: LandingLook;
  onToggleLook: () => void;
}

/**
 * Floating pill nav: transparent at the top, frosted with a soft glow once
 * scrolled. The legal pages are open to signed-in users too, who get a way
 * back into the app instead of Sign in / Get started. Nothing shows while the
 * session is being restored, so neither set flashes at the wrong person.
 */
export const LandingNav: React.FC<Props> = ({ look, onToggleLook }) => {
  const { status } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const next = window.scrollY > 20;
      setScrolled((prev) => (prev === next ? prev : next));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toBeige = look === 'midnight';

  return (
    <header className={`lp-nav ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="lp-wrap">
        <div className="lp-nav-pill">
          <Brand />
          <nav className="lp-nav-links" aria-label="Sections">
            {NAV_LINKS.map((l) => (
              <Link key={l.to} to={l.to}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="lp-nav-cta">
            <button
              type="button"
              className="lp-theme-btn"
              onClick={onToggleLook}
              aria-label={toBeige ? 'Switch to the light beige theme' : 'Switch to the dark midnight theme'}
              title={toBeige ? 'Light theme' : 'Dark theme'}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={look}
                  initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
                  animate={{ rotate: 0, opacity: 1, scale: 1 }}
                  exit={{ rotate: 90, opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.2 }}
                  style={{ display: 'grid' }}
                >
                  {toBeige ? <Sun /> : <Moon />}
                </motion.span>
              </AnimatePresence>
            </button>
            {status === 'authed' && (
              <Link className="lp-btn lp-btn-primary" to="/dashboard">
                Go to dashboard
              </Link>
            )}
            {status === 'anon' && (
              <>
                <Link className="lp-signin" to="/login">
                  Sign in
                </Link>
                <Link className="lp-btn lp-btn-primary" to="/signup">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

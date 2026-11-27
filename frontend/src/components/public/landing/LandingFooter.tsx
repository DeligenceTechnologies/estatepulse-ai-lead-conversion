import React from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';

/**
 * Every link goes somewhere that exists: real routes and sections of the home
 * page. Section links carry the `/` so they also work from /terms and /privacy;
 * the home page scrolls to the hash itself. No social links — they would be
 * dead ends.
 */
const COLUMNS: Array<{ heading: string; links: Array<{ to: string; label: string }> }> = [
  {
    heading: 'Product',
    links: [
      { to: '/#product', label: 'Features' },
      { to: '/#how-it-works', label: 'How it works' },
      { to: '/#faq', label: 'FAQ' },
    ],
  },
  {
    heading: 'Account',
    links: [
      { to: '/signup', label: 'Create your organization' },
      { to: '/login', label: 'Sign in' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { to: '/terms', label: 'Terms & Conditions' },
      { to: '/privacy', label: 'Privacy Policy' },
    ],
  },
];

/** Shared by the home page and the legal pages. */
export const LandingFooter: React.FC = () => (
  <footer className="lp-footer">
    <div className="lp-wrap">
      <div className="lp-foot-top">
        <div className="lp-foot-brand">
          <Link className="lp-foot-logo" to="/#top" aria-label="EstatePulse AI home">
            <span className="lp-brand-mark">
              <Zap />
            </span>
            <span className="lp-foot-name">EstatePulse AI</span>
          </Link>
          <p className="lp-foot-tagline">Every lead, answered</p>
          <p className="lp-foot-about">
            Lead conversion for real estate teams. Inbound leads are called, qualified and handed to the right agent
            automatically, while they are still interested.
          </p>
        </div>

        <div className="lp-foot-cols">
          {COLUMNS.map((col) => (
            <nav key={col.heading} className="lp-foot-col" aria-label={col.heading}>
              <h3>{col.heading}</h3>
              <ul>
                {col.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="lp-foot-bottom">
        <p>© {new Date().getFullYear()} EstatePulse AI. All rights reserved.</p>
        <p>Built for real estate teams.</p>
      </div>
    </div>
  </footer>
);

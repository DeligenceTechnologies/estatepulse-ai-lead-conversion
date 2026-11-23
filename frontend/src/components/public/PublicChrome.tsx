import React from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

/**
 * The header and footer shared by every public page: the home page, /terms and
 * /privacy. One copy, so a link added here appears on all of them.
 */

export const Brand: React.FC = () => (
  <Link
    to="/"
    className="min-w-0 flex items-center gap-2 sm:gap-2.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
  >
    <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
      <Zap className="w-5 h-5 text-white" />
    </div>
    {/* Sized down on a phone so the name and both buttons share one line;
        on a very narrow screen the name is cut short rather than wrapped. */}
    <span className="text-base sm:text-lg font-bold tracking-tight text-slate-100 truncate">EstatePulse AI</span>
  </Link>
);

const HEADER_LINKS: Array<{ to: string; label: string }> = [
  { to: '/#faq', label: 'FAQ' },
  { to: '/terms', label: 'Terms & Conditions' },
];

/**
 * The legal pages are open to signed-in users too, who get a way back into the
 * app instead of Sign in / Get started. Nothing is shown while the session is
 * being restored, so neither set of links flashes at the wrong person.
 *
 * The header stays at the top while the page scrolls. Anything a link scrolls
 * to needs a `scroll-mt-*` at least as tall as it (about 72px), or its heading
 * lands underneath.
 */
export const PublicHeader: React.FC = () => {
  const { status } = useAuth();
  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/70 bg-slate-950/85 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3 sm:gap-4">
        <Brand />
        <nav className="shrink-0 flex items-center gap-1 sm:gap-3 whitespace-nowrap">
          {/* Page links sit in the header from tablet width up. On a phone there
              is no room beside the buttons, and the footer carries the same links. */}
          {HEADER_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="hidden md:inline-flex px-3 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-900 transition-colors"
            >
              {link.label}
            </Link>
          ))}
          {status === 'authed' && (
            <Link
              to="/dashboard"
              className="px-2.5 sm:px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-sm font-semibold transition-colors"
            >
              Go to dashboard
            </Link>
          )}
          {status === 'anon' && (
            <>
              <Link
                to="/login"
                className="px-2.5 sm:px-4 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-900 transition-colors"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="px-2.5 sm:px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-sm font-semibold transition-colors"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
};

const FOOTER_COLUMNS: Array<{ heading: string; links: Array<{ to: string; label: string }> }> = [
  {
    heading: 'Product',
    links: [
      { to: '/#how-it-works', label: 'How it works' },
      { to: '/#features', label: 'What you get' },
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

/**
 * Every link here goes somewhere that exists: real routes and sections of the
 * home page. Section links carry the `/` so they also work from /terms and
 * /privacy; the home page scrolls to the hash itself. No social links, which
 * would be dead ends.
 */
export const PublicFooter: React.FC = () => (
  <footer className="border-t border-slate-800/70 bg-slate-950">
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
        <div className="col-span-2 space-y-3">
          <Brand />
          <p className="text-xs text-slate-500 leading-relaxed max-w-xs">
            Lead conversion for real estate teams. Inbound leads are called, qualified and handed
            to the right agent automatically.
          </p>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <div key={column.heading} className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider font-bold text-slate-300">{column.heading}</h3>
            <ul className="space-y-2 text-xs text-slate-500">
              {column.links.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="hover:text-slate-300 transition-colors">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-slate-800/70 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-xs text-slate-600">© {new Date().getFullYear()} EstatePulse AI. All rights reserved.</p>
        <p className="text-xs text-slate-600">Built for real estate teams.</p>
      </div>
    </div>
  </footer>
);

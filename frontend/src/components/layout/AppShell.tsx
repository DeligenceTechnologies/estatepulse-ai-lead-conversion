import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Building2, Menu } from 'lucide-react';

/**
 * The page frame shared by the owner and agent apps.
 *
 * On large screens the sidebar sits beside the content. Below `lg` it becomes a
 * drawer behind a menu button, so a phone gets the full width for the page.
 * Any navigation closes the drawer — watched via the path, so the sidebars
 * themselves need no extra wiring.
 */
export const AppShell: React.FC<{ sidebar: React.ReactNode; children: React.ReactNode }> = ({ sidebar, children }) => {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans selection:bg-emerald-500 selection:text-on-accent">
      {open && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </div>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="lg:hidden h-14 shrink-0 px-4 flex items-center gap-3 border-b border-slate-800 bg-slate-900">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="p-2 -ml-2 rounded-lg text-slate-300 hover:bg-slate-800 cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center">
            <Building2 className="w-4 h-4 text-on-accent" />
          </div>
          <span className="font-bold text-sm text-slate-100">EstatePulse</span>
        </header>
        {/* No global title bar on desktop: every view renders its own heading and actions. */}
        <main className="flex-1 overflow-y-auto custom-scrollbar">{children}</main>
      </div>
    </div>
  );
};

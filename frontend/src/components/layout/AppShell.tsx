import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronRight, Menu } from 'lucide-react';
import { ProfileMenu } from '../auth/ProfileMenu';
import { DashboardSidebar, type NavGroup } from './DashboardSidebar';
import { ThemeToggle } from './ThemeToggle';

const COLLAPSED_KEY = 'ep_sidebar_collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

interface AppShellProps {
  groups: NavGroup[];
  activeId: string | undefined;
  onNavigate: (id: string) => void;
  children: React.ReactNode;
}

/**
 * The page frame shared by the owner and agent apps: a collapsible sidebar on
 * the left and a sticky navbar above the page.
 *
 * On large screens the sidebar sits beside the content and can collapse to an
 * icon rail (remembered per browser). Below `lg` it becomes a drawer the
 * navbar's menu button opens; any navigation closes it.
 */
export const AppShell: React.FC<AppShellProps> = ({ groups, activeId, onNavigate, children }) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { pathname } = useLocation();
  useEffect(() => setMobileOpen(false), [pathname]);

  const toggleCollapsed = (): void =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        /* the choice just will not be remembered */
      }
      return !c;
    });

  const group = groups.find((g) => g.items.some((i) => i.id === activeId));
  const current = group?.items.find((i) => i.id === activeId);

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans selection:bg-emerald-500 selection:text-on-accent">
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}
      <DashboardSidebar
        groups={groups}
        activeId={activeId}
        onSelect={onNavigate}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleCollapsed}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="sticky top-0 z-30 h-14 shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 bg-slate-900/90 backdrop-blur-xl border-b border-slate-800">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              className="lg:hidden flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer transition-colors"
            >
              <Menu className="w-[18px] h-[18px]" />
            </button>
            {current && (
              <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0 text-xs">
                {group?.label && (
                  <>
                    <span className="hidden sm:inline text-slate-500 truncate">{group.label}</span>
                    <ChevronRight className="hidden sm:block w-3.5 h-3.5 text-slate-600 shrink-0" />
                  </>
                )}
                <span className="font-semibold text-slate-100 truncate">{current.label}</span>
              </nav>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <ThemeToggle />
            <div className="w-px h-6 bg-slate-800 mx-1" aria-hidden />
            <ProfileMenu />
          </div>
        </header>

        {/* Every view renders its own heading and actions below the navbar. */}
        <main className="flex-1 overflow-y-auto custom-scrollbar">{children}</main>
      </div>
    </div>
  );
};

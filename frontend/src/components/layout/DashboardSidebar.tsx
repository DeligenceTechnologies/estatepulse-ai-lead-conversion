import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Building2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  /** Navigable but not built yet. */
  soon?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

interface DashboardSidebarProps {
  groups: NavGroup[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  /** Desktop only: icons-only rail. Phones always get the full drawer. */
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onMobileClose: () => void;
}

const NavRow: React.FC<{ item: NavItem; active: boolean; collapsed: boolean; onClick: () => void }> = ({
  item,
  active,
  collapsed,
  onClick,
}) => {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`relative w-full flex items-center rounded-xl text-sm transition-all duration-200 cursor-pointer gap-2.5 px-2.5 py-2.5 ${
        collapsed ? 'lg:justify-center lg:gap-0 lg:px-0 lg:h-11' : ''
      } ${
        active
          ? 'bg-emerald-500/10 text-emerald-300 font-bold ring-1 ring-inset ring-emerald-500/25'
          : 'font-semibold text-slate-300 hover:text-emerald-300 hover:bg-emerald-500/5'
      }`}
    >
      {active && (
        <span aria-hidden className="absolute -left-2 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-emerald-400" />
      )}
      <Icon
        aria-hidden
        className={`shrink-0 w-[17px] h-[17px] ${collapsed ? 'lg:w-[19px] lg:h-[19px]' : ''} ${
          active ? 'text-emerald-400' : 'text-slate-500'
        }`}
        strokeWidth={active ? 2.4 : 2}
      />
      <span className={`flex-1 text-left truncate ${collapsed ? 'lg:sr-only' : ''}`}>{item.label}</span>
      {item.soon && <span className={`text-2xs font-medium text-slate-500 ${collapsed ? 'lg:hidden' : ''}`}>Soon</span>}
      {!!item.badge && (
        <>
          <span
            className={`text-2xs font-semibold px-1.5 min-w-5 text-center rounded-full bg-slate-800 text-slate-300 ${
              collapsed ? 'lg:hidden' : ''
            }`}
          >
            {item.badge}
          </span>
          {collapsed && (
            <span aria-hidden className="hidden lg:block absolute top-2 right-3 w-1.5 h-1.5 rounded-full bg-emerald-400" />
          )}
        </>
      )}
    </button>
  );
};

/**
 * The left navigation shared by the owner and agent apps: brand, grouped
 * links with a bar marking the open page, and a collapse toggle that turns it
 * into an icon rail on desktop. Below `lg` it is a drawer the navbar opens.
 */
export const DashboardSidebar: React.FC<DashboardSidebarProps> = ({
  groups,
  activeId,
  onSelect,
  collapsed,
  mobileOpen,
  onToggle,
  onMobileClose,
}) => {
  const { organization } = useAuth();

  return (
    <aside
      className={`fixed lg:static inset-y-0 left-0 z-50 h-screen flex flex-col shrink-0 overflow-hidden select-none
        bg-slate-900 border-r border-slate-800 shadow-[2px_0_16px_rgba(0,0,0,0.12)] lg:shadow-none
        transition-[width,transform] duration-300 ease-in-out w-60 ${collapsed ? 'lg:w-[68px]' : ''}
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
    >
      {/* Brand */}
      <div
        className={`h-14 shrink-0 flex items-center justify-between px-4 border-b border-slate-800 ${
          collapsed ? 'lg:justify-center lg:px-2' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect('dashboard')}
          title="EstatePulse home"
          className="flex items-center gap-2.5 min-w-0 cursor-pointer"
        >
          <div className="w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md shadow-emerald-500/30">
            <Building2 className="w-4 h-4 text-on-accent" />
          </div>
          <div className={`min-w-0 text-left leading-tight ${collapsed ? 'lg:hidden' : ''}`}>
            <span className="block font-bold text-sm tracking-tight text-slate-100">
              Estate<span className="text-emerald-400">Pulse</span>
            </span>
            <span className="block text-2xs text-slate-500 truncate max-w-[140px]">{organization?.name ?? '—'}</span>
          </div>
        </button>
        <button
          type="button"
          onClick={onMobileClose}
          aria-label="Close menu"
          className="lg:hidden w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      {/* Links */}
      <nav aria-label="Main" className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 py-3">
        {groups.map((group, gi) => (
          <div key={group.label ?? gi} className={gi === 0 ? '' : 'mt-4'}>
            {group.label && (
              <>
                <p
                  className={`px-2.5 mb-1.5 text-2xs font-bold uppercase tracking-wider text-slate-500 ${
                    collapsed ? 'lg:sr-only' : ''
                  }`}
                >
                  {group.label}
                </p>
                {collapsed && <div aria-hidden className="hidden lg:block mx-3 mb-2 border-t border-slate-800" />}
              </>
            )}
            <ul className="flex flex-col gap-1 list-none">
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavRow
                    item={item}
                    active={activeId === item.id}
                    collapsed={collapsed}
                    onClick={() => {
                      onSelect(item.id);
                      onMobileClose();
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Collapse (desktop only) */}
      <div className="hidden lg:block shrink-0 border-t border-slate-800 p-2">
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className={`w-full flex items-center gap-2.5 rounded-xl text-sm font-bold text-slate-400 bg-slate-950/60 border border-slate-800
            hover:text-emerald-300 hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors cursor-pointer ${
              collapsed ? 'justify-center h-11' : 'px-2.5 py-2.5'
            }`}
        >
          {collapsed ? (
            <PanelLeftOpen className="w-[19px] h-[19px]" aria-hidden />
          ) : (
            <>
              <PanelLeftClose className="w-[17px] h-[17px]" aria-hidden />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
};

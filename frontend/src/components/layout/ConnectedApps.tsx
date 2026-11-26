import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plug } from 'lucide-react';
import { getConnectedApps, isBroken, type AppState, type ConnectedApp, type ConnectedAppsDTO } from '../../utils/connectedAppsApi';

const REFRESH_MS = 60_000;

const DOT: Record<AppState, string> = {
  connected: 'bg-emerald-400',
  syncing: 'bg-sky-400 animate-pulse',
  error: 'bg-amber-400',
  needs_reconnect: 'bg-rose-500',
};

const STATE_TEXT: Record<AppState, string> = {
  connected: 'Connected',
  syncing: 'Syncing…',
  error: 'Not syncing',
  needs_reconnect: 'Disconnected',
};

/** The line under an app's name: what is wrong, or whose account it is. */
const subline = (app: ConnectedApp): string => (app.state === 'connected' && app.account ? app.account : STATE_TEXT[app.state]);

interface Props {
  collapsed: boolean;
  /** Called after a navigation, so the phone drawer closes. */
  onNavigate: () => void;
}

/**
 * The sidebar's Connected apps: every app the office connected, with a dot for whether it works.
 * Everyone sees it, since a broken calendar or phone line stops everyone's work; only people who
 * may manage integrations get the Reconnect button, which opens the page where it is fixed.
 * Refreshed every minute and whenever the window comes back into focus.
 */
export const ConnectedApps: React.FC<Props> = ({ collapsed, onNavigate }) => {
  const navigate = useNavigate();
  const [data, setData] = useState<ConnectedAppsDTO | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void getConnectedApps()
        .then((d) => alive && setData(d))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, []);

  if (!data) return null;
  return (
    <ConnectedAppsView
      data={data}
      collapsed={collapsed}
      onOpen={(path) => {
        navigate(path);
        onNavigate();
      }}
    />
  );
};

/** The list itself, from data already loaded. */
export const ConnectedAppsView: React.FC<{ data: ConnectedAppsDTO; collapsed: boolean; onOpen: (path: string) => void }> = ({ data, collapsed, onOpen: open }) => {
  if (data.apps.length === 0) return null;
  const broken = data.apps.filter(isBroken);

  return (
    <div className="mt-5">
      <p className={`px-2.5 mb-1.5 text-2xs font-bold uppercase tracking-wider text-slate-500 ${collapsed ? 'lg:sr-only' : ''}`}>Connected apps</p>
      {collapsed && <div aria-hidden className="hidden lg:block mx-3 mb-2 border-t border-slate-800" />}

      {/* The icon rail: one plug, red when anything needs attention. */}
      {collapsed && (
        <button
          type="button"
          onClick={() => open(data.canReconnect && broken[0] ? broken[0].reconnectPath : '/integrations')}
          title={broken.length ? broken.map((a) => `${a.label}: ${STATE_TEXT[a.state]}`).join('\n') : 'All apps connected'}
          aria-label={broken.length ? `${broken.length} connected app${broken.length === 1 ? '' : 's'} need attention` : 'All apps connected'}
          className="hidden lg:flex relative w-full h-10 items-center justify-center rounded-xl text-slate-500 hover:text-emerald-300 hover:bg-emerald-500/5 cursor-pointer"
        >
          <Plug className="w-[19px] h-[19px]" aria-hidden />
          <span aria-hidden className={`absolute top-2 right-4 w-2 h-2 rounded-full ${broken.length ? 'bg-rose-500' : 'bg-emerald-400'}`} />
        </button>
      )}

      <ul className={`flex flex-col gap-0.5 list-none ${collapsed ? 'lg:hidden' : ''}`}>
        {data.apps.map((app) => (
          <li key={app.id} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl" title={app.message ?? undefined}>
            <span aria-hidden className={`shrink-0 w-2 h-2 rounded-full ${DOT[app.state]}`} />
            <span className="flex-1 min-w-0 leading-tight">
              <span className="block text-sm font-semibold text-slate-300 truncate">{app.label}</span>
              <span className={`block text-2xs truncate ${isBroken(app) ? 'text-rose-300' : 'text-slate-500'}`}>{subline(app)}</span>
            </span>
            {isBroken(app) && data.canReconnect && (
              <button
                type="button"
                onClick={() => open(app.reconnectPath)}
                className="shrink-0 text-2xs font-bold text-emerald-300 hover:text-emerald-200 cursor-pointer"
              >
                Reconnect
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

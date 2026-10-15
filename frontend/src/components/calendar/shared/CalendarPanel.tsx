import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { messageFor } from '../../../lib/api';

type Resource<T> = { data: T | null; error: string | null; loading: boolean };

/**
 * One read live from the provider. A refresh keeps the rows on screen
 * while it runs; a failed refresh replaces them with the error.
 */
export const useProviderData = <T,>(fetcher: () => Promise<T>): Resource<T> & { reload: () => Promise<void> } => {
  const [state, setState] = useState<Resource<T>>({ data: null, error: null, loading: true });

  const reload = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const data = await fetcher();
      setState({ data, error: null, loading: false });
    } catch (e) {
      setState({ data: null, error: messageFor(e), loading: false });
    }
  }, [fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
};

/** Runs `reload` each time the page's Sync button finishes (not on mount: the page loads itself). */
export const useReloadOnSync = (syncVersion: number, reload: () => unknown): void => {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (syncVersion > 0) void latest.current();
  }, [syncVersion]);
};

/** The card each Calendar page sits in: a title row with count, then the content. Syncing lives in the page header. */
export const PanelCard: React.FC<{
  icon: React.ElementType;
  title: string;
  hint: string;
  count: number | undefined;
  loading: boolean;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon: Icon, title, hint, count, loading, toolbar, children }) => (
  <section className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden">
    <header className="px-4 sm:px-5 py-4 border-b border-slate-800 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-slate-950 border border-slate-800 text-emerald-400 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              {title}
              {count !== undefined && (
                <span className="text-2xs font-semibold text-slate-300 bg-slate-800 rounded-md px-1.5 py-0.5 tabular-nums">
                  {count}
                </span>
              )}
              {loading && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" aria-label="Loading" />}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{hint}</p>
          </div>
        </div>
      </div>
      {toolbar}
    </header>
    <div className="p-4 sm:p-5">{children}</div>
  </section>
);

export const RowSkeleton: React.FC = () => (
  <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 list-none animate-pulse" aria-hidden>
    {[0, 1, 2, 3].map((i) => (
      <li key={i} className="flex items-center gap-3 px-4 py-3">
        <span className="w-9 h-9 rounded-full bg-slate-800" />
        <span className="flex-1 space-y-1.5">
          <span className="block h-2.5 w-40 rounded bg-slate-800" />
          <span className="block h-2 w-56 rounded bg-slate-800/70" />
        </span>
      </li>
    ))}
  </ul>
);

import React from 'react';
import { Clock3 } from 'lucide-react';

/**
 * Placeholder for sections that are navigable but not built yet.
 *
 * Which sections are locked is decided by the view map in App.tsx, not here and
 * not inside the feature views: no view component knows whether it is locked,
 * so unlocking one is a single line in that map.
 */
export const ComingSoonView: React.FC<{ title: string }> = ({ title }) => (
  <div className="p-6 max-w-7xl mx-auto text-slate-100">
    <div className="flex flex-col items-center justify-center text-center bg-slate-900 border border-slate-800 rounded-2xl px-6 py-16">
      <div className="w-12 h-12 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-4">
        <Clock3 className="w-6 h-6 text-amber-400" />
      </div>

      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold text-white tracking-tight">{title}</h2>
        <span className="text-2xs uppercase font-mono px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800/40">
          Pending
        </span>
      </div>

      <p className="text-sm font-semibold text-slate-200 mt-3">Coming Soon</p>
      <p className="text-xs text-slate-400 mt-1.5 max-w-md">
        This feature is currently being prepared and will be available in a future release.
      </p>
    </div>
  </div>
);

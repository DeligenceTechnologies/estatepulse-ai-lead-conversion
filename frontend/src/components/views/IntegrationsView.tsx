import React from 'react';
import { Plug } from 'lucide-react';

/** Lead Integrations: the third-party tools leads arrive from. Telnyx and the calendar live under Settings. */
export const IntegrationsView: React.FC = () => (
  <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
    <div>
      <h2 className="text-xl font-bold text-white tracking-tight">Lead Integrations</h2>
      <p className="text-xs text-slate-400">Connect the apps your leads come from.</p>
    </div>
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-10 text-center space-y-2">
      <Plug className="w-6 h-6 text-slate-500 mx-auto" />
      <p className="text-sm text-slate-300">No integrations yet.</p>
    </div>
  </div>
);

import React from 'react';
import { ConnectionCards } from '../integrations/ConnectionCards';

/**
 * Lead Integrations: the third-party tools leads arrive from, one card each.
 * What they bring in is reported on Lead Sources. Telnyx and the calendar are
 * organization settings and live under Settings.
 */
export const IntegrationsView: React.FC = () => (
  <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
    <div>
      <h2 className="text-xl font-bold text-white tracking-tight">Lead Integrations</h2>
      <p className="text-xs text-slate-400">
        Connect the tools your leads come from. Every lead they send shows up on{' '}
        <span className="text-slate-300">Lead Sources</span>.
      </p>
    </div>

    <ConnectionCards />
  </div>
);

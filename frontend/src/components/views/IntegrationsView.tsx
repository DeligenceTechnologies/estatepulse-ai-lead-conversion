import React from 'react';
import { Lightbulb } from 'lucide-react';
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
        Connect the apps your leads come from. New leads show up in <span className="text-slate-200 font-semibold">Lead Sources</span>.
      </p>
    </div>

    {/* Before any source is connected: calling hours follow each lead's own time zone, so a field for it helps. */}
    <div className="flex items-start gap-2.5 bg-sky-500/10 border border-sky-500/25 rounded-xl px-3.5 py-2.5 text-xs">
      <Lightbulb className="w-4 h-4 text-sky-300 shrink-0 mt-px" />
      <p className="text-slate-300">
        <span className="font-semibold text-white">Tip:</span> add a <span className="font-semibold text-white">Time Zone</span> field to
        your form or sheet. We call and text in each lead's local time; without it we guess from the phone number.
      </p>
    </div>

    <ConnectionCards />
  </div>
);

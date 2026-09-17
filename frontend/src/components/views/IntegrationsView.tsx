import React from 'react';
import { Zap } from 'lucide-react';
import { ConnectionCards } from '../integrations/ConnectionCards';

interface IntegrationsViewProps {
  onOpenWebhookTester: () => void;
}

/**
 * Connections, and only connections.
 *
 * This page used to carry a live lead-source list with per-source lead counts,
 * delivery detail and a second webhook-token manager, on top of a grid of demo
 * integration cards. All of that either duplicated Lead Sources — the screen
 * that actually reports what came in — or described nothing real. What is left
 * is the two ways a lead source can exist: we install the webhook, or you do.
 */
export const IntegrationsView: React.FC<IntegrationsViewProps> = ({ onOpenWebhookTester }) => (
  <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">Integrations &amp; Webhooks</h2>
        <p className="text-xs text-slate-400">
          Connect where your leads come from. What they bring in is on{' '}
          <span className="text-slate-300">Lead Sources</span>.
        </p>
      </div>

      <button
        onClick={onOpenWebhookTester}
        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-amber-950 transition-colors cursor-pointer shrink-0"
      >
        <Zap className="w-4 h-4 fill-current" />
        <span>Launch Webhook Tester</span>
      </button>
    </div>

    <ConnectionCards />
  </div>
);

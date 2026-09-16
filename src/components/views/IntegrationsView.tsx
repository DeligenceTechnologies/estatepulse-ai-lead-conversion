import React from 'react';
import { 
  Cpu, 
  CheckCircle2, 
  AlertTriangle, 
  Zap, 
  ExternalLink, 
  ShieldCheck, 
  RefreshCw,
  Terminal,
  Key,
  Radio,
  Webhook
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

interface IntegrationsViewProps {
  onOpenWebhookTester: () => void;
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({ onOpenWebhookTester }) => {
  const { integrations, setActiveView } = useApp();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Integrations & Webhook Hub</h2>
          <p className="text-xs text-slate-400">
            Real-estate CRM synchronization, Retell Voice AI, Twilio SMS, and calendar automations
          </p>
        </div>

        <button
          onClick={onOpenWebhookTester}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-amber-950 transition-colors cursor-pointer"
        >
          <Zap className="w-4 h-4 fill-current" />
          <span>Launch Webhook Tester</span>
        </button>
      </div>

      {/* Integration Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/*
          The ONLY real integration on this page.

          Hardcoded rather than added to INITIAL_INTEGRATIONS on purpose: that
          array is demo seed data in AppContext, and putting a live integration
          in it would start the demo/live merge the codebase is built to avoid.
          It is a signpost, not a status display — it deliberately fetches
          nothing, because reading live state here would mean this view calling
          the real API.
        */}
        <div className="bg-slate-900/90 border border-emerald-500/40 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                Forms
              </span>
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
                <Radio className="w-3 h-3" />
                Live
              </span>
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Tally Forms</h3>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Connect a form with an API key and we install the webhook for you, then map its
                fields before the first submission arrives.
              </p>
            </div>
            <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl text-[11px] text-slate-400 leading-relaxed">
              This is the only integration on this page backed by the real API — the others are
              demo data.
            </div>
          </div>
          <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
            <span className="text-slate-500 font-mono text-[11px]">Managed in Lead Sources</span>
            <button
              onClick={() => setActiveView('lead_sources')}
              className="text-emerald-400 hover:text-emerald-300 font-medium transition-colors cursor-pointer"
            >
              Connect a form →
            </button>
          </div>
        </div>

        {integrations.map(integ => (
          <div
            key={integ.id}
            className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                  {integ.category}
                </span>

                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 ${
                  integ.status === 'connected'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800 text-slate-400'
                }`}>
                  {integ.status === 'connected' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                  {integ.status}
                </span>
              </div>

              <div>
                <h3 className="text-base font-bold text-white">{integ.name}</h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">{integ.description}</p>
              </div>

              <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-400">
                  <span>API Key Configured:</span>
                  <span className={integ.config.apiKeySet ? 'text-emerald-400 font-semibold' : 'text-slate-500'}>
                    {integ.config.apiKeySet ? 'Active / Encrypted' : 'Not Provided'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Last Synchronized:</span>
                  <span className="text-slate-300 font-mono text-[11px]">{integ.lastSyncAt}</span>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-500 font-mono text-[11px]">
                {integ.config.accountReference || 'Ready to Connect'}
              </span>
              <button 
                onClick={onOpenWebhookTester}
                className="text-cyan-400 hover:text-cyan-300 font-medium transition-colors cursor-pointer"
              >
                Test Sync →
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Generic Webhook Endpoints Documentation (PRD Section 15 & 66) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold text-white">Generic Ingestion & Outbound Webhooks</h3>
          </div>
          <span className="text-xs text-slate-400 font-mono">REST JSON API</span>
        </div>

        <p className="text-xs text-slate-300">
          Any lead provider, CRM, Meta Lead Ad, or Zapier/Make workflow can trigger lead creation or receive real-time status changes:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
          <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl space-y-1">
            <div className="text-emerald-400 font-bold">POST /api/webhooks/leads</div>
            <div className="text-[11px] text-slate-400 font-sans">Ingest new buyer lead with auto-response trigger</div>
          </div>

          <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl space-y-1">
            <div className="text-cyan-400 font-bold">POST /api/webhooks/lead-status</div>
            <div className="text-[11px] text-slate-400 font-sans">CRM push callback for stage updates or agent assignment</div>
          </div>

          <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl space-y-1">
            <div className="text-purple-400 font-bold">POST /api/webhooks/appointment</div>
            <div className="text-[11px] text-slate-400 font-sans">Calendly booking, cancellation, or reschedule payload</div>
          </div>

          <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl space-y-1">
            <div className="text-amber-400 font-bold">POST /api/webhooks/conversation</div>
            <div className="text-[11px] text-slate-400 font-sans">Twilio inbound SMS delivery and STOP/DNC opt-out handling</div>
          </div>
        </div>
      </div>

    </div>
  );
};

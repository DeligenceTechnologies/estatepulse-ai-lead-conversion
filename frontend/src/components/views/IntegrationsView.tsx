import React, { useEffect, useState } from 'react';
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
  Phone
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getIntegrations, disconnectTelnyx, reconnectTelnyx, type OrgIntegration } from '../../utils/assistantApi';
import { IngestSourcesCard } from './IngestSourcesCard';
import { ConnectTallyPanel } from './ConnectTallyPanel';

interface IntegrationsViewProps {
  onOpenWebhookTester: () => void;
}

// Friendly labels — never expose the raw provider name to the user.
const PROVIDER_LABEL: Record<string, string> = { telnyx: 'AI Voice Agent', estatepulse: '' };

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({ onOpenWebhookTester }) => {
  const { integrations } = useApp();
  const [live, setLive] = useState<OrgIntegration[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = () => getIntegrations().then(setLive).catch(() => setLive([]));
  useEffect(() => { void refresh(); }, []);

  const toggle = async (provider: string, active: boolean) => {
    if (provider !== 'telnyx') return;
    setBusy(true);
    try {
      await (active ? disconnectTelnyx() : reconnectTelnyx());
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  // Only providers with a user-facing label (hide internal rows like the strategy store).
  const liveProviders = live.filter((i) => PROVIDER_LABEL[i.provider]);

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

      {/* Live connections (from your account, real DB) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          Your Connected Providers
        </h3>
        {liveProviders.length === 0 ? (
          <p className="text-xs text-slate-500">No providers connected yet. Connect one in <span className="text-slate-300">AI Prompt &amp; Tone</span>.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {liveProviders.map((i) => {
              const active = i.status === 'active';
              return (
                <div key={i.id} className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Phone className="w-4 h-4 text-cyan-400" />
                    <div>
                      <div className="text-sm font-semibold text-white">{PROVIDER_LABEL[i.provider]}</div>
                      <div className="text-[11px] text-slate-500">
                        {i.metadata?.fromNumber ? `Number: ${i.metadata.fromNumber} · ` : ''}
                        {i.externalAccountId ? 'Assistant linked' : 'No assistant'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${active ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40' : 'bg-slate-800/60 text-slate-400 border-slate-700/40'}`}>
                      {active ? 'Connected' : 'Disconnected'}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggle(i.provider, active)}
                      className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border disabled:opacity-50 ${active ? 'text-rose-400 border-rose-900/50 hover:text-rose-300' : 'text-emerald-400 border-emerald-800/50 hover:text-emerald-300'}`}
                    >
                      {active ? 'Disconnect' : 'Reconnect'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Integration Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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

        {/* Tally connection card — sits in the same grid as the other integrations */}
        <ConnectTallyPanel />
      </div>

      {/* Generic lead-ingestion source manager (manual webhook token for any provider) */}
      <IngestSourcesCard />

    </div>
  );
};

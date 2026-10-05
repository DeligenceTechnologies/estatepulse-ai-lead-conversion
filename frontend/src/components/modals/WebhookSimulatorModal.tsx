import React, { useState } from 'react';
import { X, Zap, Copy, Check, Terminal, Play, CheckCircle2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';

interface WebhookSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WebhookSimulatorModal: React.FC<WebhookSimulatorModalProps> = ({ isOpen, onClose }) => {
  const { triggerWebhookTest, setSelectedLeadId } = useApp();

  const samplePayloads: Record<string, any> = {
    zillow: {
      organization_key: "org_austin_home_advisors",
      source: "zillow",
      source_id: "zil_listing_7721",
      first_name: "Brandon",
      last_name: "Hayes",
      phone: "+15125550291",
      email: "b.hayes@austintech.com",
      location: "Round Rock / Brushy Creek",
      budget_min: 600000,
      budget_max: 750000
    },
    facebook: {
      organization_key: "org_austin_home_advisors",
      source: "facebook",
      source_id: "fb_leadgen_form_88",
      first_name: "Elena",
      last_name: "Rostova",
      phone: "+15125550388",
      email: "elena.r@gmail.com",
      location: "North Austin / The Domain",
      budget_min: 450000,
      budget_max: 550000
    },
    website: {
      organization_key: "org_austin_home_advisors",
      source: "website",
      source_id: "idx_search_save_44",
      first_name: "Marcus",
      last_name: "Vance",
      phone: "+15125550419",
      email: "mvance@outlook.com",
      location: "Cedar Park / Leander",
      budget_min: 520000,
      budget_max: 680000
    }
  };

  const [preset, setPreset] = useState<string>('zillow');
  const [rawJson, setRawJson] = useState<string>(JSON.stringify(samplePayloads.zillow, null, 2));
  const [responseJson, setResponseJson] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleSelectPreset = (key: string) => {
    setPreset(key);
    setRawJson(JSON.stringify(samplePayloads[key], null, 2));
    setResponseJson(null);
  };

  const handleExecuteWebhook = () => {
    try {
      const parsed = JSON.parse(rawJson);
      const created = triggerWebhookTest(parsed);
      const res = {
        success: true,
        lead_id: created.id,
        status: "created",
        assigned_agent: "Alex Vance",
        score: created.score,
        strategy: "Strategy B (Voice -> SMS if unanswered)",
        response_time_ms: 42,
        audit_logged: true
      };
      setResponseJson(JSON.stringify(res, null, 2));
      setTimeout(() => {
        onClose();
        setSelectedLeadId(created.id);
      }, 1400);
    } catch (e: any) {
      setResponseJson(JSON.stringify({ error: "Invalid JSON payload", details: e.message }, null, 2));
    }
  };

  const curlCommand = `curl -X POST https://api.estatepulse.ai/v1/webhooks/leads \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer org_sec_austin_live" \\
  -d '${rawJson.replace(/\n/g, '').replace(/\s+/g, ' ')}'`;

  const handleCopyCurl = () => {
    navigator.clipboard.writeText(curlCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100 flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Lead Ingestion Webhook Tester</h3>
              <p className="text-xs text-slate-400">Endpoint: <code className="text-cyan-400 font-mono">POST /api/webhooks/leads</code> (PRD Section 66)</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          
          {/* Preset buttons */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400 font-medium">Load Preset:</span>
            {['zillow', 'facebook', 'website'].map(key => (
              <button
                key={key}
                onClick={() => handleSelectPreset(key)}
                className={`px-3 py-1 rounded-lg capitalize border transition-colors cursor-pointer ${
                  preset === key 
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 font-semibold' 
                    : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                {key}
              </button>
            ))}
          </div>

          {/* JSON Payload Editor */}
          <div>
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span>Request JSON Body:</span>
              <button
                onClick={handleCopyCurl}
                className="flex items-center gap-1 text-xs text-slate-300 hover:text-white transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied cURL' : 'Copy as cURL'}</span>
              </button>
            </div>
            <textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              rows={8}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-cyan-300 focus:outline-none focus:border-cyan-500 leading-relaxed custom-scrollbar"
            />
          </div>

          {/* Execution Response Box */}
          {responseJson && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Response (200 OK — Ingested & Strategy Dispatched):</span>
              </div>
              <pre className="bg-slate-950 border border-emerald-500/30 rounded-xl p-3 font-mono text-xs text-emerald-300 overflow-x-auto">
                {responseJson}
              </pre>
            </div>
          )}

          <div className="bg-slate-950/60 border border-slate-800/80 p-3 rounded-xl text-xs text-slate-400 leading-relaxed">
            <span className="font-semibold text-slate-300">Backend Pipeline Behavior:</span> When executed, the ingestion engine normalizes the payload, assigns a round-robin agent, evaluates duplicate phone/email, and triggers automated voice & SMS outreach according to organization strategy rules.
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleExecuteWebhook}
            className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer shadow-md shadow-amber-950"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Send Webhook POST</span>
          </button>
        </div>

      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { 
  Sliders, 
  Sparkles, 
  ShieldCheck, 
  Clock, 
  MapPin, 
  Check, 
  AlertTriangle,
  Building2,
  CheckCircle2,
  Save
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const AISettingsView: React.FC = () => {
  const { orgSettings, updateOrgSettings } = useApp();

  const [aiName, setAiName] = useState(orgSettings.aiAgentName);
  const [tone, setTone] = useState(orgSettings.aiTone);
  const [strategy, setStrategy] = useState(orgSettings.communicationStrategy);
  const [startHour, setStartHour] = useState(orgSettings.businessHours.start);
  const [endHour, setEndHour] = useState(orgSettings.businessHours.end);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    updateOrgSettings({
      aiAgentName: aiName,
      aiTone: tone,
      communicationStrategy: strategy,
      businessHours: {
        ...orgSettings.businessHours,
        start: startHour,
        end: endHour,
      }
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const qualificationChecklist = [
    { label: 'Buying Intent (Move-in vs Investment vs Relocation)', required: true },
    { label: 'Timeline to Purchase (<30 days, 1-3 mos, 3-6 mos)', required: true },
    { label: 'Target Location & Submarkets (North Austin, Round Rock)', required: true },
    { label: 'Budget Range (Min & Max)', required: true },
    { label: 'Property Type & Minimum Bedrooms (e.g. 4 beds, Single Family)', required: false },
    { label: 'Financing Status & Lender Pre-approval Letter', required: false },
    { label: 'Primary Motivation (Schools, backyard, lease expiration)', required: false },
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">AI Agent & Qualification Rules</h2>
          <p className="text-xs text-slate-400">
            Configure system prompts, voice persona, deterministic scoring rubric, and business hours (PRD Section 44)
          </p>
        </div>

        {savedSuccess && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold bg-emerald-950/60 border border-emerald-800/40 px-3 py-1.5 rounded-xl">
            <CheckCircle2 className="w-4 h-4" />
            <span>Settings Saved & Deployed to Retell/n8n</span>
          </div>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        
        {/* Core Persona & Strategy */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            AI Voice Persona & Communication Strategy
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">AI Assistant Name</label>
              <input
                type="text"
                value={aiName}
                onChange={(e) => setAiName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
              <span className="text-[11px] text-slate-500 mt-1 block">Used in voice call greetings & SMS sender IDs</span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Conversational Tone</label>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              >
                <option value="Conversational">Conversational (Natural, Warm, Human-like)</option>
                <option value="Professional">Professional (Polished, Consultative, Corporate)</option>
                <option value="Friendly">Friendly (Casual, Enthusiastic)</option>
                <option value="Concise">Concise (Fast, Direct, Low-word count)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">Outbound Communication Strategy (PRD Section 27)</label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 text-xs">
              {[
                'Strategy B (Voice -> SMS if unanswered)',
                'Strategy A (SMS -> Voice)',
                'Strategy C (SMS -> Voice -> Follow-up)'
              ].map(strat => (
                <div
                  key={strat}
                  onClick={() => setStrategy(strat as any)}
                  className={`p-3 rounded-xl border transition-all cursor-pointer ${
                    strategy === strat
                      ? 'bg-emerald-600/15 border-emerald-500/50 text-white font-semibold'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>{strat.split(' (')[0]}</span>
                    {strategy === strat && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                  </div>
                  <span className="text-[10px] text-slate-500 block mt-0.5">
                    {strat.includes('B') ? 'Recommended default: immediate voice call' : strat}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Qualification Rubric (PRD Section 22) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            Active Qualification Rubric (Extracted by AI)
          </h3>
          <p className="text-xs text-slate-400">
            The voice agent conversationally gathers these fields without reading off a rigid checklist:
          </p>

          <div className="space-y-2 text-xs">
            {qualificationChecklist.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-2.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-slate-200 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{item.label}</span>
                </span>
                <span className={`text-[10px] uppercase font-bold font-mono px-2 py-0.5 rounded ${
                  item.required ? 'bg-rose-950 text-rose-300' : 'bg-slate-800 text-slate-400'
                }`}>
                  {item.required ? 'Required for Score' : 'Recommended'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Business Hours & Compliance Guardrails (PRD Section 23 & 54) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" />
            Contact Window & Safety Guardrails
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Permitted Contact Hours (CST)</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={startHour}
                  onChange={(e) => setStartHour(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-28 text-center"
                />
                <span className="text-slate-400">to</span>
                <input
                  type="text"
                  value={endHour}
                  onChange={(e) => setEndHour(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-28 text-center"
                />
              </div>
              <span className="text-[10px] text-slate-500 mt-1 block">Voice calls outside these hours queue until next window</span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">DNC & Opt-Out Handling</label>
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-[11px] text-slate-300 space-y-1">
                <div className="text-emerald-400 font-semibold">Strict TCPA STOP Enforcement: Active</div>
                <p className="text-slate-400">Any text containing "STOP", "UNSUBSCRIBE", or verbal DNC request immediately cancels all follow-ups.</p>
              </div>
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-[11px] text-slate-400 space-y-1">
            <span className="font-semibold text-slate-200">Strict Non-Goals Enforced in System Prompt (PRD Section 4 & 23):</span>
            <p>AI agent never gives legal advice, never guarantees mortgage approval, never makes unverified pricing promises, and escalates to a human agent whenever uncertain.</p>
          </div>
        </div>

        {/* Submit */}
        <div className="flex justify-end">
          <button
            type="submit"
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-950 flex items-center gap-2 transition-colors cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>Save Configuration</span>
          </button>
        </div>

      </form>

    </div>
  );
};

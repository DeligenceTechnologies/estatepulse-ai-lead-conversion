import React, { useState } from 'react';
import { 
  Building2, 
  Sparkles, 
  PhoneCall, 
  MessageSquare, 
  Calendar, 
  ShieldCheck, 
  Clock, 
  ArrowRight, 
  CheckCircle2, 
  Flame, 
  DollarSign, 
  Play, 
  Users,
  Zap
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const PublicLandingPageView: React.FC = () => {
  const { 
    setActiveView, 
    createLead, 
    setSelectedLeadId, 
    startLiveCallSimulation,
    orgSettings 
  } = useApp();

  // Demo Lead Form State (PRD Section 60 & 61)
  const [demoName, setDemoName] = useState('Sarah Johnson');
  const [demoPhone, setDemoPhone] = useState('+1 (512) 555-0199');
  const [demoEmail, setDemoEmail] = useState('sarah.johnson@example.com');
  const [demoLocation, setDemoLocation] = useState('North Austin');
  const [demoBudget, setDemoBudget] = useState('500000-650000');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleTestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const parts = demoName.split(' ');
    const firstName = parts[0] || 'Demo';
    const lastName = parts.slice(1).join(' ') || 'Prospect';

    let bMin = 500000;
    let bMax = 650000;
    if (demoBudget.includes('-')) {
      const bParts = demoBudget.split('-');
      bMin = Number(bParts[0]) || 500000;
      bMax = Number(bParts[1]) || 650000;
    }

    const newLead = createLead({
      firstName,
      lastName,
      phone: demoPhone,
      email: demoEmail,
      preferredLocation: demoLocation,
      budgetMin: bMin,
      budgetMax: bMax,
      source: 'website',
      timeline: '1-3 months',
      bedrooms: 4,
      propertyType: 'Single Family Home',
    }, true);

    setTimeout(() => {
      setIsSubmitting(false);
      startLiveCallSimulation(newLead);
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-emerald-500 selection:text-white">
      
      {/* Navigation Bar */}
      <header className="h-20 border-b border-slate-800/80 px-6 md:px-12 flex items-center justify-between bg-slate-950/80 backdrop-blur sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-white font-bold shadow-lg shadow-emerald-950">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-base tracking-tight text-white">EstatePulse AI</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">V1.0</span>
            </div>
            <p className="text-[11px] text-slate-400">Lead Conversion System for Real Estate Teams</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveView('dashboard')}
            className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors cursor-pointer"
          >
            Enter Management Portal →
          </button>
        </div>
      </header>

      {/* Hero Section (PRD Section 59) */}
      <section className="py-16 md:py-24 px-6 md:px-12 max-w-7xl mx-auto flex flex-col items-center text-center space-y-6">
        
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-xs font-medium text-emerald-400">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>Austin Home Advisors • Live Production Showcase</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold text-white tracking-tight max-w-4xl leading-tight">
          Turn More Real Estate Leads Into <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">Appointments</span> With AI
        </h1>

        <p className="text-base md:text-lg text-slate-300 max-w-2xl leading-relaxed">
          Respond instantly under 60 seconds, qualify buyer timelines and budgets automatically, conduct intelligent follow-ups, and deliver pre-briefed appointments directly to your agents.
        </p>

        {/* Speed Comparison Banner */}
        <div className="flex flex-wrap items-center justify-center gap-6 pt-2 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            <span>Average Brokerage Response: <strong className="text-slate-200">4.8 Hours</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span>EstatePulse AI Response: <strong className="text-emerald-400 font-mono">38 Seconds</strong></span>
          </div>
        </div>

      </section>

      {/* Live Interactive Demo Form (PRD Section 60 & 61: Recommended Demo Scenario) */}
      <section className="px-6 md:px-12 max-w-4xl mx-auto w-full pb-16">
        <div className="bg-gradient-to-b from-slate-900 to-slate-950 border-2 border-emerald-500/40 rounded-3xl p-6 md:p-8 shadow-2xl shadow-emerald-950/40 space-y-6 relative overflow-hidden">
          
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs uppercase font-extrabold text-emerald-400 tracking-wider flex items-center gap-1.5">
                <Flame className="w-4 h-4 text-rose-400" />
                Live Demo Experience (PRD Section 60 & 61)
              </span>
              <h2 className="text-xl font-bold text-white">Test the AI Inbound Response Engine</h2>
              <p className="text-xs text-slate-300">
                Submit this sample buyer lead. Watch the AI voice agent dial within seconds, qualify timeline and budget, calculate a lead score of 87+, and synchronize with the dashboard!
              </p>
            </div>
          </div>

          <form onSubmit={handleTestSubmit} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Prospect Full Name</label>
                <input
                  type="text"
                  required
                  value={demoName}
                  onChange={(e) => setDemoName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Prospect Phone Number</label>
                <input
                  type="text"
                  required
                  value={demoPhone}
                  onChange={(e) => setDemoPhone(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={demoEmail}
                  onChange={(e) => setDemoEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Target Area / Submarket</label>
                <input
                  type="text"
                  required
                  value={demoLocation}
                  onChange={(e) => setDemoLocation(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Budget Range ($)</label>
                <input
                  type="text"
                  required
                  value={demoBudget}
                  onChange={(e) => setDemoBudget(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                Preset with recommended demo lead: <strong>Sarah Johnson ($500k-$650k, North Austin)</strong>
              </span>

              <button
                type="submit"
                disabled={isSubmitting}
                className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold text-xs shadow-xl shadow-emerald-950/60 flex items-center gap-2 transition-all cursor-pointer"
              >
                <PhoneCall className="w-4 h-4 animate-pulse" />
                <span>{isSubmitting ? 'Dispatching AI Voice Call...' : 'Submit & Trigger Instant AI Call'}</span>
              </button>
            </div>
          </form>

        </div>
      </section>

      {/* 6-Step Workflow Section (PRD Section 59: How it Works) */}
      <section className="py-16 px-6 md:px-12 max-w-7xl mx-auto border-t border-slate-800/80 space-y-12">
        <div className="text-center space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">End-To-End Architecture</span>
          <h2 className="text-2xl md:text-3xl font-bold text-white">How the Lead Conversion Engine Works</h2>
          <p className="text-xs text-slate-400 max-w-lg mx-auto">
            From inbound webhook ingestion to agent consultation without human friction
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {[
            { step: '01', title: 'Lead Arrives', desc: 'Zillow, Facebook Ads, or Website form triggers webhook ingestion' },
            { step: '02', title: 'AI Responds', desc: 'Outbound Retell voice call dials within 38 seconds' },
            { step: '03', title: 'AI Qualifies', desc: 'Determines timeline, budget, preferred area, and mortgage pre-approval' },
            { step: '04', title: 'Lead Scored', desc: 'Deterministic rubric rates prospect 0–100 (HOT, WARM, or COLD)' },
            { step: '05', title: 'Appointment', desc: 'Direct booking onto agent Calendly with calendar invite sync' },
            { step: '06', title: 'Agent Briefing', desc: 'Pre-call screen presents full buyer dossier for smooth handoff' },
          ].map((item, idx) => (
            <div key={idx} className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-2 relative">
              <span className="text-2xl font-black text-slate-700 font-mono block">{item.step}</span>
              <h4 className="text-xs font-bold text-white">{item.title}</h4>
              <p className="text-[11px] text-slate-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 md:px-12 border-t border-slate-800/80 text-center text-xs text-slate-500">
        EstatePulse AI — V1.0 Lead Conversion System for US Real Estate Teams & Brokerages.
      </footer>

    </div>
  );
};

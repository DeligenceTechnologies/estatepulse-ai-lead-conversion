import React from 'react';
import { 
  Search, 
  PhoneForwarded, 
  Bell, 
  Sparkles, 
  Flame, 
  CheckCircle2, 
  Clock, 
  ShieldCheck,
  Zap,
  Globe,
  LogOut
} from 'lucide-react';
import { isLockedView, useApp } from '../../context/AppContext';
import { displayName, initialsFor, roleLabel, useAuth } from '../../context/AuthContext';

interface HeaderProps {
  onOpenNewLead: () => void;
  onOpenWebhookTester: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenNewLead, onOpenWebhookTester }) => {
  const { 
    activeView, 
    setActiveView, 
    leads, 
    orgSettings, 
    startLiveCallSimulation,
    setPreCallLeadId 
  } = useApp();
  const { user, role, logout } = useAuth();

  const hotLead = leads.find(l => l.temperature === 'hot');
  const demoLead = leads[0];
  // Locked sections show ComingSoonView, so the demo KPIs would be the only
  // numbers on screen and would read as real.
  const locked = isLockedView(activeView);

  const viewTitles: Record<string, { title: string; subtitle: string }> = {
    lead_sources: {
      title: 'Lead Sources',
      subtitle: 'Live webhook endpoints — real data from Postgres, not the demo store'
    },
    dashboard: {
      title: 'Conversion Command Center', 
      subtitle: 'Real-time overview of inbound lead velocity, AI response times, and booking rate' 
    },
    leads: { 
      title: 'Lead Management & Pipeline', 
      subtitle: 'Track buyer readiness scores, qualification confidence, and next actions' 
    },
    conversations: { 
      title: 'Omnichannel Conversations', 
      subtitle: 'Live unified SMS and web chat with AI assistant Alex & manual agent takeover' 
    },
    calls: { 
      title: 'Retell AI Voice Call Studio', 
      subtitle: 'Outbound & inbound call logs, audio playback, transcripts, and structured extraction' 
    },
    appointments: {
      title: 'Scheduled Appointments',
      subtitle: 'Consultations synced from the office calendar, linked to the lead who booked'
    },
    followups: { 
      title: 'Automated Follow-up Sequences', 
      subtitle: 'Trigger-based multi-step nurture workflows with STOP/DNC compliance rules' 
    },
    agents: { 
      title: 'Agent Team & Routing Engine', 
      subtitle: 'Manage agent schedules, calendar links, and round-robin routing rules' 
    },
    integrations: { 
      title: 'Integrations & Webhooks Hub', 
      subtitle: 'Follow Up Boss CRM, Twilio, Retell AI, and Calendly API connections' 
    },
    ai_settings: { 
      title: 'AI Agent & Qualification Rules', 
      subtitle: 'Configure assistant persona, qualification rubric, and escalation thresholds' 
    },
    analytics: { 
      title: 'Conversion Analytics & ROI Model', 
      subtitle: 'First-response speed audit, stage drop-offs, and estimated pipeline value' 
    },
    landing_page: { 
      title: 'Public Landing Page & Live Demo', 
      subtitle: 'Visitor experience with instant lead response simulation' 
    }
  };

  const currentInfo = viewTitles[activeView] || { title: 'Lead Conversion Platform', subtitle: orgSettings.name };

  return (
    <header className="h-16 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur px-6 flex items-center justify-between shrink-0 z-10">
      {/* Title & View Context */}
      <div className="flex items-center gap-4">
        <div>
          <h1 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            {currentInfo.title}
            {activeView === 'landing_page' && (
              <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                Visitor View
              </span>
            )}
          </h1>
          <p className="text-[11px] text-slate-400 hidden md:block truncate max-w-md">{currentInfo.subtitle}</p>
        </div>
      </div>

      {/* Center Live Ticker (Speed & Qualification KPIs) */}
      {!locked && (
      <div className="hidden lg:flex items-center gap-3 text-xs bg-slate-950/70 px-3 py-1.5 rounded-full border border-slate-800/80">
        <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
          <Clock className="w-3.5 h-3.5" />
          <span>Avg First Response: <strong className="text-white font-mono">38s</strong></span>
        </div>
        <span className="text-slate-700">•</span>
        <div className="flex items-center gap-1.5 text-slate-300">
          <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
          <span>Qualification Rate: <strong className="text-white font-mono">71%</strong></span>
        </div>
        <span className="text-slate-700">•</span>
        <div className="flex items-center gap-1.5 text-amber-400">
          <Flame className="w-3.5 h-3.5 text-rose-400" />
          <span>Hot Leads: <strong className="text-white font-mono">{leads.filter(l => l.temperature === 'hot').length}</strong></span>
        </div>
      </div>
      )}

      {/* Right Controls */}
      <div className="flex items-center gap-2.5">
        {/* Agent Pre-Call Screen Trigger */}
        {!locked && hotLead && (
          <button
            onClick={() => setPreCallLeadId(hotLead.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500/20 to-rose-500/20 border border-amber-500/40 text-amber-300 text-xs font-semibold hover:border-amber-400 transition-all cursor-pointer shadow-sm shadow-amber-950/50"
          >
            <Flame className="w-3.5 h-3.5 text-rose-400 animate-bounce" />
            <span>Agent Pre-Call Briefing</span>
          </button>
        )}

        {/* Live Interactive Voice Call Simulator */}
        {!locked && demoLead && (
          <button
            onClick={() => startLiveCallSimulation(demoLead)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium transition-all cursor-pointer"
            title="Launch live interactive voice agent simulation"
          >
            <PhoneForwarded className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Simulate AI Call</span>
          </button>
        )}

        {/* View Landing Page Switcher */}
        {activeView !== 'landing_page' ? (
          <button
            onClick={() => setActiveView('landing_page')}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 text-xs transition-colors cursor-pointer"
            title="View Public Landing Page & Live Demo Form"
          >
            <Globe className="w-4 h-4 text-emerald-400" />
          </button>
        ) : (
          <button
            onClick={() => setActiveView('dashboard')}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium transition-colors cursor-pointer"
          >
            Back to Dashboard
          </button>
        )}

        {/* Authenticated user */}
        <div className="pl-2 border-l border-slate-800 flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-200">
            {initialsFor(user)}
          </div>
          <div className="hidden xl:block text-left">
            <div className="text-xs font-medium text-slate-200 leading-tight">{displayName(user)}</div>
            <div className="text-[10px] text-emerald-400">{roleLabel(role)}</div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="ml-1 p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};

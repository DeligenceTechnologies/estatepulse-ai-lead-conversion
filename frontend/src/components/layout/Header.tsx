import React from 'react';
import { 
  Search, 
  Bell, 
  Sparkles, 
  CheckCircle2, 
  Zap,
  Globe
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const Header: React.FC = () => {
  const { activeView, setActiveView, orgSettings } = useApp();

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

      {/* Right Controls */}
      <div className="flex items-center gap-2.5">
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

      </div>
    </header>
  );
};

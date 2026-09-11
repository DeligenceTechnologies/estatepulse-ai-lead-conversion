import React from 'react';
import { 
  LayoutDashboard, 
  Users, 
  MessageSquare, 
  PhoneCall, 
  Calendar, 
  GitFork, 
  UserCheck, 
  Cpu, 
  Sliders, 
  BarChart3, 
  Globe, 
  PlusCircle, 
  Flame, 
  RotateCcw,
  Sparkles,
  Zap,
  Building2
} from 'lucide-react';
import { useApp, AppView } from '../../context/AppContext';

interface SidebarProps {
  onOpenNewLead: () => void;
  onOpenWebhookTester: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ onOpenNewLead, onOpenWebhookTester }) => {
  const { 
    activeView, 
    setActiveView, 
    leads, 
    orgSettings, 
    resetDemoData, 
    setPreCallLeadId 
  } = useApp();

  const hotLeadsCount = leads.filter(l => l.temperature === 'hot').length;
  const newLeadsCount = leads.filter(l => l.status === 'new').length;

  const navItems: { id: AppView; label: string; icon: React.ReactNode; badge?: string | number; badgeColor?: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
    { 
      id: 'leads', 
      label: 'Leads & Pipeline', 
      icon: <Users className="w-4 h-4" />, 
      badge: leads.length,
      badgeColor: 'bg-slate-800 text-slate-300'
    },
    { 
      id: 'conversations', 
      label: 'Conversations & SMS', 
      icon: <MessageSquare className="w-4 h-4" /> 
    },
    { 
      id: 'calls', 
      label: 'AI Voice Calls', 
      icon: <PhoneCall className="w-4 h-4" />,
      badge: 'Retell',
      badgeColor: 'bg-cyan-950/80 text-cyan-400 border border-cyan-800/40'
    },
    { 
      id: 'appointments', 
      label: 'Appointments', 
      icon: <Calendar className="w-4 h-4" /> 
    },
    { 
      id: 'followups', 
      label: 'Follow-Up Sequences', 
      icon: <GitFork className="w-4 h-4" /> 
    },
    { 
      id: 'agents', 
      label: 'Agent Team & Routing', 
      icon: <UserCheck className="w-4 h-4" /> 
    },
    { 
      id: 'integrations', 
      label: 'Integrations & Webhooks', 
      icon: <Cpu className="w-4 h-4" /> 
    },
    { 
      id: 'ai_settings', 
      label: 'AI Prompt & Tone', 
      icon: <Sliders className="w-4 h-4" /> 
    },
    { 
      id: 'analytics', 
      label: 'Analytics & ROI', 
      icon: <BarChart3 className="w-4 h-4" /> 
    },
  ];

  return (
    <aside className="w-64 bg-slate-900/95 border-r border-slate-800/80 flex flex-col h-screen shrink-0 backdrop-blur select-none">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800/70 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-950/50 text-white font-bold text-lg">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-sm text-slate-100 tracking-tight">EstatePulse</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">AI</span>
            </div>
            <p className="text-[11px] text-slate-400 truncate max-w-[130px]">{orgSettings.name}</p>
          </div>
        </div>
      </div>

      {/* System Status Pill */}
      <div className="px-4 pt-3 pb-1">
        <div className="bg-slate-950/60 rounded-lg p-2.5 border border-slate-800/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-[11px] font-medium text-slate-300">Voice AI: <strong>{orgSettings.aiAgentName}</strong></span>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono">24/7 LIVE</span>
        </div>
      </div>

      {/* Hot Lead Alert Banner if Hot Leads Exist */}
      {hotLeadsCount > 0 && (
        <div className="px-4 py-2">
          <button
            onClick={() => {
              const hotLead = leads.find(l => l.temperature === 'hot');
              if (hotLead) setPreCallLeadId(hotLead.id);
            }}
            className="w-full text-left bg-gradient-to-r from-amber-500/15 via-rose-500/15 to-amber-500/15 border border-amber-500/30 hover:border-amber-500/60 rounded-lg p-2.5 transition-all group cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                <Flame className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
                {hotLeadsCount} HOT Lead{hotLeadsCount > 1 ? 's' : ''} Ready
              </span>
              <span className="text-[10px] text-amber-200 group-hover:translate-x-0.5 transition-transform font-medium">Briefing →</span>
            </div>
            <p className="text-[10px] text-slate-400 mt-0.5">Click for Agent Pre-Call Screen</p>
          </button>
        </div>
      )}

      {/* Navigation List */}
      <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-300 px-3 py-1">
          Conversion Engine
        </div>
        {navItems.map(item => {
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                isActive 
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30' 
                  : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span className={isActive ? 'text-emerald-400' : 'text-slate-400'}>{item.icon}</span>
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && (
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${item.badgeColor || 'bg-slate-800 text-slate-300'}`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}

        <div className="pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-slate-300 px-3">
          Public Experience
        </div>
        <button
          onClick={() => setActiveView('landing_page')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            activeView === 'landing_page' 
              ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30' 
              : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Globe className="w-4 h-4 text-emerald-400" />
            <span>Public Landing Page</span>
          </div>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">Demo Mode</span>
        </button>
      </nav>

      {/* Action Buttons & Footer */}
      <div className="p-3 border-t border-slate-800/80 space-y-2 bg-slate-950/40">
        <button
          onClick={onOpenNewLead}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-950 transition-all cursor-pointer"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>New Inbound Lead</span>
        </button>

        <button
          onClick={onOpenWebhookTester}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-slate-300 text-xs font-medium border border-slate-700/60 transition-all cursor-pointer"
        >
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span>Test Webhook Payload</span>
        </button>

        <button
          onClick={resetDemoData}
          title="Reset to Austin Home Advisors seed demo state"
          className="w-full flex items-center justify-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 py-1 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Reset Demo Scenario</span>
        </button>
      </div>
    </aside>
  );
};

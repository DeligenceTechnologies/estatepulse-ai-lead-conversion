import React from 'react';
import { 
  UserCheck, 
  Phone, 
  Mail, 
  Calendar, 
  Clock, 
  CheckCircle2, 
  TrendingUp, 
  GitBranch,
  ShieldCheck,
  Plus
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const AgentsView: React.FC = () => {
  const { agents, orgSettings, updateOrgSettings } = useApp();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Agent Team & Lead Routing</h2>
          <p className="text-xs text-slate-400">
            Configure agent availability, calendar URLs, and automated round-robin assignment rules
          </p>
        </div>

        <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-emerald-400" />
          <span>Active Routing: <strong className="text-white capitalize">{orgSettings.leadRoutingMethod.replace('_', ' ')}</strong></span>
        </div>
      </div>

      {/* Lead Routing Configuration Card (PRD Section 21) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-cyan-400" />
          Lead Distribution Algorithm
        </h3>
        <p className="text-xs text-slate-400">
          When an inbound lead arrives, the n8n ingestion workflow (WF-03) distributes leads across eligible team members based on the selected policy:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs">
          {[
            { id: 'round_robin', title: 'Round-Robin (Default)', desc: 'Agent A → Agent B → Agent C → Agent A evenly.' },
            { id: 'geographic', title: 'Geographic Routing', desc: 'North Austin → Alex, Cedar Park → Sarah, Downtown → Mike.' },
            { id: 'availability', title: 'Availability First', desc: 'Assign only to agents currently marked available with open calendar slots.' }
          ].map(opt => (
            <div
              key={opt.id}
              onClick={() => updateOrgSettings({ leadRoutingMethod: opt.id as any })}
              className={`p-3.5 rounded-xl border transition-all cursor-pointer space-y-1 ${
                orgSettings.leadRoutingMethod === opt.id
                  ? 'bg-emerald-600/15 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-200">{opt.title}</span>
                {orgSettings.leadRoutingMethod === opt.id && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                )}
              </div>
              <p className="text-[11px] text-slate-400">{opt.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Agents Roster Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {agents.map(agent => (
          <div 
            key={agent.id}
            className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src={agent.avatarUrl}
                    alt={agent.name}
                    className="w-12 h-12 rounded-xl object-cover border border-slate-700 shadow-md"
                  />
                  <div>
                    <h4 className="text-sm font-bold text-white">{agent.name}</h4>
                    <span className="text-[11px] text-slate-400 capitalize">{agent.role}</span>
                  </div>
                </div>

                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase font-mono ${
                  agent.status === 'available' 
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' 
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                }`}>
                  {agent.status}
                </span>
              </div>

              <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-2 text-xs">
                <div className="flex items-center gap-2 text-slate-300">
                  <Phone className="w-3.5 h-3.5 text-slate-500" />
                  <span className="font-mono">{agent.phone}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-300 truncate">
                  <Mail className="w-3.5 h-3.5 text-slate-500" />
                  <span>{agent.email}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Clock className="w-3.5 h-3.5 text-slate-500" />
                  <span>{agent.workingHours}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-slate-400 block text-[10px]">Active Leads</span>
                  <span className="font-bold text-white font-mono text-sm">{agent.assignedLeadsCount}</span>
                </div>
                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-slate-400 block text-[10px]">Conversion Rate</span>
                  <span className="font-bold text-emerald-400 font-mono text-sm">{agent.conversionRate}%</span>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800">
              <a
                href={agent.calendarUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>View Calendly Schedule</span>
              </a>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
};

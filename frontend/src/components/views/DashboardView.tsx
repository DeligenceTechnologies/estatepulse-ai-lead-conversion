import React from 'react';
import { 
  Users, 
  PhoneCall, 
  CheckCircle2, 
  Calendar, 
  Clock, 
  Flame, 
  DollarSign, 
  TrendingUp, 
  Sparkles, 
  ArrowRight, 
  PhoneForwarded, 
  ShieldCheck, 
  Zap, 
  Activity,
  AlertCircle,
  ExternalLink
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const DashboardView: React.FC = () => {
  const { 
    leads, 
    calls, 
    appointments, 
    auditLogs, 
    setSelectedLeadId, 
    setPreCallLeadId,
    startLiveCallSimulation,
    setActiveView 
  } = useApp();

  const hotLeads = leads.filter(l => l.temperature === 'hot');
  const contactedLeads = leads.filter(l => l.status !== 'new');
  const qualifiedLeads = leads.filter(l => l.status === 'qualified' || l.status === 'appointment_booked');
  const totalPipeline = leads.reduce((acc, l) => acc + (l.budgetMax || 0), 0);

  const contactRate = leads.length > 0 ? Math.round((contactedLeads.length / leads.length) * 100) : 0;
  const qualRate = contactedLeads.length > 0 ? Math.round((qualifiedLeads.length / contactedLeads.length) * 100) : 0;

  // Funnel steps (PRD Section 36)
  const funnelSteps = [
    { label: 'Leads Ingested', count: leads.length, pct: 100, color: 'bg-slate-600' },
    { label: 'Contacted (<60s)', count: contactedLeads.length, pct: contactRate, color: 'bg-cyan-600' },
    { label: 'AI Engaged', count: Math.max(1, contactedLeads.length), pct: 85, color: 'bg-emerald-600' },
    { label: 'Qualified', count: qualifiedLeads.length, pct: qualRate, color: 'bg-amber-500' },
    { label: 'Appointment', count: appointments.length, pct: Math.round((appointments.length / leads.length) * 100), color: 'bg-rose-500' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Hero Welcome & Speed Metric Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-900/90 to-emerald-950/40 border border-slate-800 rounded-2xl p-6 relative overflow-hidden shadow-xl">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                Autonomous Lead Response
              </span>
              <span className="text-xs text-slate-400 font-mono">Austin Home Advisors</span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Speed-to-Lead: <span className="text-emerald-400 font-mono">38 Seconds</span> Average Response
            </h2>
            <p className="text-xs text-slate-300 max-w-xl">
              Industry benchmark is 4.8 hours. EstatePulse AI connects via voice & SMS within 60 seconds, qualifies timeline, budget, and financing, and routes hot appointments to agents.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {leads[0] && (
              <button
                onClick={() => startLiveCallSimulation(leads[0])}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white text-xs font-bold shadow-lg shadow-emerald-950 flex items-center gap-2 transition-all cursor-pointer"
              >
                <PhoneForwarded className="w-4 h-4" />
                <span>Simulate Inbound Call</span>
              </button>
            )}

            <button
              onClick={() => setActiveView('leads')}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors cursor-pointer"
            >
              View Full Pipeline
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid (PRD Section 36) */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span>Total Inbound Leads</span>
            <Users className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-extrabold text-white font-mono">{leads.length}</div>
          <div className="text-[11px] text-emerald-400 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> +14% this week
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span>Lead Contact Rate</span>
            <PhoneCall className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-extrabold text-white font-mono">{contactRate}%</div>
          <div className="text-[11px] text-slate-400">Target: &gt;90% under 60s</div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span>Appointments Booked</span>
            <Calendar className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-extrabold text-white font-mono">{appointments.length}</div>
          <div className="text-[11px] text-purple-300">Calendly direct sync</div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs">
            <span>Estimated Active Pipeline</span>
            <DollarSign className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-extrabold text-white font-mono">${(totalPipeline / 1000000).toFixed(2)}M</div>
          <div className="text-[11px] text-amber-400">Buyer purchasing power</div>
        </div>

      </div>

      {/* Two Column Section: Funnel on Left, Hot Leads Action List on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left: Visual Lead Conversion Funnel (PRD Section 36) */}
        <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-bold text-white">Lead Conversion Funnel</h3>
            </div>
            <span className="text-xs text-slate-400">Real-time Progression</span>
          </div>

          <div className="space-y-3 pt-2">
            {funnelSteps.map((step, idx) => (
              <div key={idx} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300 font-medium">{step.label}</span>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="font-bold text-white">{step.count}</span>
                    <span className="text-slate-500 text-[11px]">({step.pct}%)</span>
                  </div>
                </div>
                <div className="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden p-0.5 border border-slate-800">
                  <div 
                    className={`h-full rounded-full transition-all duration-500 ${step.color}`} 
                    style={{ width: `${Math.max(8, step.pct)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>Zero manual data entry needed</span>
            <span className="text-emerald-400 font-medium">94% Automated Qualification</span>
          </div>
        </div>

        {/* Right: Urgent Hot Leads Alert & Pre-Call Quick Access (PRD Section 41) */}
        <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-rose-400" />
                <h3 className="text-sm font-bold text-white">Hot Leads Requiring Agent Touch</h3>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-bold font-mono">
                {hotLeads.length} HOT
              </span>
            </div>

            <div className="space-y-2.5">
              {hotLeads.slice(0, 3).map(lead => (
                <div 
                  key={lead.id}
                  className="p-3 bg-slate-950/70 border border-slate-800 hover:border-amber-500/40 rounded-xl transition-all flex items-center justify-between group"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-100 group-hover:text-amber-300 transition-colors">
                        {lead.firstName} {lead.lastName}
                      </span>
                      <span className="text-[10px] font-extrabold text-rose-400 font-mono">
                        SCORE {lead.score}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      ${(lead.budgetMin / 1000).toFixed(0)}k–${(lead.budgetMax / 1000).toFixed(0)}k • {lead.preferredLocation}
                    </p>
                  </div>

                  <button
                    onClick={() => setPreCallLeadId(lead.id)}
                    className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[11px] font-semibold transition-colors cursor-pointer shrink-0"
                  >
                    Pre-Call Screen
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-[11px] text-slate-400 flex items-center justify-between">
            <span>Strategy B Default Active:</span>
            <span className="text-slate-200 font-medium">Voice call then SMS if no answer</span>
          </div>
        </div>

      </div>

      {/* Recent Activity Audit Feed (PRD Section 36 & 55) */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold text-white">Live System Activity & Audit Trail</h3>
          </div>
          <span className="text-xs text-slate-400">Realtime Event Stream</span>
        </div>

        <div className="divide-y divide-slate-800/60">
          {auditLogs.slice(0, 6).map(log => (
            <div key={log.id} className="py-2.5 flex items-start justify-between gap-4 text-xs">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-200">{log.action}</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                    {log.actor}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">{log.description}</p>
              </div>
              <span className="text-[10px] text-slate-500 font-mono shrink-0">
                {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};

import React, { useState } from 'react';
import { 
  Search, 
  Filter, 
  Flame, 
  Phone, 
  MessageSquare, 
  Calendar, 
  Sparkles, 
  Plus, 
  ArrowUpDown,
  CheckCircle2,
  Clock,
  ExternalLink,
  ChevronRight
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { Lead, LeadTemperature, LeadStatus, LeadSource } from '../../types';

interface LeadsViewProps {
  onOpenNewLead: () => void;
}

export const LeadsView: React.FC<LeadsViewProps> = ({ onOpenNewLead }) => {
  const { 
    leads, 
    agents, 
    setSelectedLeadId, 
    setPreCallLeadId, 
    startLiveCallSimulation 
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTab, setSelectedTab] = useState<'all' | LeadTemperature | 'new' | 'appointment_booked'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const filteredLeads = leads.filter(lead => {
    // Tab filter
    if (selectedTab === 'hot' && lead.temperature !== 'hot') return false;
    if (selectedTab === 'warm' && lead.temperature !== 'warm') return false;
    if (selectedTab === 'cold' && lead.temperature !== 'cold') return false;
    if (selectedTab === 'new' && lead.status !== 'new') return false;
    if (selectedTab === 'appointment_booked' && lead.status !== 'appointment_booked') return false;

    // Source filter
    if (sourceFilter !== 'all' && lead.source !== sourceFilter) return false;

    // Agent filter
    if (agentFilter !== 'all' && lead.assignedAgentId !== agentFilter) return false;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = `${lead.firstName} ${lead.lastName}`.toLowerCase().includes(q);
      const matchPhone = lead.phone.includes(q);
      const matchEmail = lead.email.toLowerCase().includes(q);
      const matchLoc = lead.preferredLocation.toLowerCase().includes(q);
      if (!matchName && !matchPhone && !matchEmail && !matchLoc) return false;
    }

    return true;
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Top Header & Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Lead Pipeline Management</h2>
          <p className="text-xs text-slate-400">
            {leads.length} total buyer leads across autonomous qualification stages
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenNewLead}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold shadow-md shadow-emerald-950 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add New Lead</span>
          </button>
        </div>
      </div>

      {/* Filter Tabs & Search Controls */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-4 shadow-lg">
        
        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
          {[
            { id: 'all', label: `All Leads (${leads.length})` },
            { id: 'hot', label: `🔥 Hot (${leads.filter(l => l.temperature === 'hot').length})` },
            { id: 'warm', label: `☀️ Warm (${leads.filter(l => l.temperature === 'warm').length})` },
            { id: 'cold', label: `❄️ Cold (${leads.filter(l => l.temperature === 'cold').length})` },
            { id: 'new', label: `New Inbound (${leads.filter(l => l.status === 'new').length})` },
            { id: 'appointment_booked', label: `Appointments (${leads.filter(l => l.status === 'appointment_booked').length})` },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setSelectedTab(tab.id as any)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                selectedTab === tab.id
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Select dropdowns */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 text-xs">
          
          <div className="md:col-span-6 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, phone, email, or submarket..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="md:col-span-3">
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="all">All Lead Sources</option>
              <option value="facebook">Meta / Facebook Lead Ads</option>
              <option value="zillow">Zillow Premier Agent</option>
              <option value="website">Website IDX Search</option>
              <option value="google">Google Ads PPC</option>
              <option value="webhook">Generic API Webhooks</option>
            </select>
          </div>

          <div className="md:col-span-3">
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="all">All Assigned Agents</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

        </div>

      </div>

      {/* Leads Table (PRD Section 37) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-4 py-3.5">Lead / Contact</th>
                <th className="px-4 py-3.5">Score & Temperature</th>
                <th className="px-4 py-3.5">Target Budget & Location</th>
                <th className="px-4 py-3.5">Timeline</th>
                <th className="px-4 py-3.5">Assigned Agent</th>
                <th className="px-4 py-3.5">Status</th>
                <th className="px-4 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredLeads.length > 0 ? (
                filteredLeads.map(lead => {
                  const agent = agents.find(a => a.id === lead.assignedAgentId) || agents[0];
                  return (
                    <tr 
                      key={lead.id} 
                      className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                      onClick={() => setSelectedLeadId(lead.id)}
                    >
                      {/* Name & Contact */}
                      <td className="px-4 py-3.5">
                        <div className="space-y-0.5">
                          <div className="font-bold text-slate-100 group-hover:text-emerald-400 transition-colors flex items-center gap-1.5">
                            <span>{lead.firstName} {lead.lastName}</span>
                            <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                              {lead.source}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono">{lead.phone}</div>
                        </div>
                      </td>

                      {/* Score & Temperature */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1 font-mono ${
                            lead.temperature === 'hot'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                              : lead.temperature === 'warm'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                          }`}>
                            {lead.temperature === 'hot' && <Flame className="w-3 h-3 text-rose-400" />}
                            {lead.score}
                          </span>
                          <span className="text-[11px] text-slate-400 uppercase font-semibold">
                            {lead.temperature}
                          </span>
                        </div>
                      </td>

                      {/* Target Budget & Location */}
                      <td className="px-4 py-3.5">
                        <div className="space-y-0.5">
                          <div className="font-bold text-emerald-400 font-mono">
                            ${(lead.budgetMin / 1000).toFixed(0)}k – ${(lead.budgetMax / 1000).toFixed(0)}k
                          </div>
                          <div className="text-[11px] text-slate-300 truncate max-w-[150px]">
                            {lead.preferredLocation}
                          </div>
                        </div>
                      </td>

                      {/* Timeline */}
                      <td className="px-4 py-3.5">
                        <span className="text-slate-200 font-medium">
                          {lead.timeline}
                        </span>
                      </td>

                      {/* Agent */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-slate-800 text-[10px] font-bold text-slate-300 flex items-center justify-center">
                            {agent.name.split(' ').map(n => n[0]).join('')}
                          </div>
                          <span className="text-slate-300">{agent.name}</span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3.5">
                        <span className={`text-[11px] px-2 py-0.5 rounded-md font-mono uppercase ${
                          lead.status === 'appointment_booked'
                            ? 'bg-purple-950 text-purple-300 border border-purple-800/40'
                            : lead.status === 'qualified'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40'
                            : lead.status === 'contacted'
                            ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/40'
                            : 'bg-slate-800 text-slate-300'
                        }`}>
                          {lead.status.replace('_', ' ')}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => startLiveCallSimulation(lead)}
                            title="Trigger Voice AI Call"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-emerald-600 text-slate-300 hover:text-white transition-colors cursor-pointer"
                          >
                            <Phone className="w-3.5 h-3.5" />
                          </button>

                          {lead.temperature === 'hot' && (
                            <button
                              onClick={() => setPreCallLeadId(lead.id)}
                              title="Agent Pre-Call Briefing"
                              className="p-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-colors cursor-pointer"
                            >
                              <Flame className="w-3.5 h-3.5 text-rose-400" />
                            </button>
                          )}

                          <button
                            onClick={() => setSelectedLeadId(lead.id)}
                            title="Open Full Dossier"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No leads match the selected criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};

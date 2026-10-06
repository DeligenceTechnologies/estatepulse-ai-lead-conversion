import React from 'react';
import { 
  Flame, 
  Phone, 
  Calendar, 
  MapPin, 
  DollarSign, 
  Clock, 
  Home, 
  CheckCircle2, 
  X, 
  Sparkles, 
  UserCheck, 
  ArrowRight,
  ExternalLink,
  ShieldCheck,
  AlertCircle
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const AgentPreCallModal: React.FC = () => {
  const { 
    preCallLeadId, 
    setPreCallLeadId, 
    findLead, 
    setSelectedLeadId, 
    takeOverConversation,
    startLiveCallSimulation 
  } = useApp();

  if (!preCallLeadId) return null;

  const lead = findLead(preCallLeadId);
  if (!lead) return null;

  const handleOpenDossier = () => {
    setSelectedLeadId(lead.id);
    setPreCallLeadId(null);
  };

  const handleAcceptAndConnect = () => {
    takeOverConversation(lead.id);
    setPreCallLeadId(null);
    startLiveCallSimulation(lead);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-slate-900 border-2 border-amber-500/60 rounded-2xl shadow-2xl shadow-amber-950/40 overflow-hidden text-slate-100">
        
        {/* Glow Accent Header */}
        <div className="relative bg-gradient-to-r from-amber-600/30 via-rose-600/30 to-amber-600/30 p-6 border-b border-amber-500/30 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-500/50 flex items-center justify-center text-amber-400 shadow-inner">
              <Flame className="w-7 h-7 text-rose-400 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-widest font-extrabold px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  🔥 HOT LEAD
                </span>
                <span className="text-xs text-amber-300/80 font-mono">Transferred from Voice AI</span>
              </div>
              <h2 className="text-2xl font-bold text-white mt-1">
                {lead.firstName} {lead.lastName}
              </h2>
              <p className="text-xs text-slate-300 flex items-center gap-2 mt-0.5">
                <span>{lead.phone}</span>
                <span>•</span>
                <span>{lead.email}</span>
              </p>
            </div>
          </div>

          <button
            onClick={() => setPreCallLeadId(null)}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Core Briefing Content (PRD Section 41 Exact Specifications) */}
        <div className="p-6 space-y-6">
          
          {/* Key Facts 4-Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                <span>Budget</span>
              </div>
              <div className="text-sm font-bold text-emerald-300 font-mono">
                ${(lead.budgetMin / 1000).toFixed(0)}K – ${(lead.budgetMax / 1000).toFixed(0)}K
              </div>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                <MapPin className="w-3.5 h-3.5 text-cyan-400" />
                <span>Location</span>
              </div>
              <div className="text-sm font-bold text-slate-200 truncate">
                {lead.preferredLocation}
              </div>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>Timeline</span>
              </div>
              <div className="text-sm font-bold text-slate-200">
                {lead.timeline}
              </div>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-xl">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                <Home className="w-3.5 h-3.5 text-purple-400" />
                <span>Property / Beds</span>
              </div>
              <div className="text-sm font-bold text-slate-200">
                {lead.bedrooms} Beds ({lead.propertyType})
              </div>
            </div>
          </div>

          {/* Financing & Motivation Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-slate-950/60 border border-slate-800/80 p-3.5 rounded-xl">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
                Financing Status
              </div>
              <p className="text-xs text-slate-200">
                {lead.financingStatus || 'Needs connection with preferred local mortgage broker.'}
              </p>
            </div>

            <div className="bg-slate-950/60 border border-slate-800/80 p-3.5 rounded-xl">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                Primary Motivation
              </div>
              <p className="text-xs text-slate-200">
                {lead.qualification?.motivation || 'Family relocation; targeting high-rated public school districts.'}
              </p>
            </div>
          </div>

          {/* AI Conversation Summary & Qualification Brief */}
          <div className="bg-slate-950/90 border border-amber-500/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-amber-300">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-400" />
                AI Voice Qualification Summary (Alex)
              </span>
              <span className="text-[11px] text-emerald-400 font-mono">94% Confidence</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {lead.scoreBreakdown?.reasoningSummary || 
               'Lead answered outbound voice inquiry within 38 seconds. Confirmed urgency to purchase within 60 days. Open to morning consultation call and interested in lender pre-approval guidance.'}
            </p>
          </div>

          {/* Action Row */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <button
              onClick={handleOpenDossier}
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-2 border border-slate-700 transition-colors cursor-pointer"
            >
              <span>View Full Lead Dossier</span>
              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
            </button>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleAcceptAndConnect}
                className="flex-1 sm:flex-initial px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white text-xs font-bold shadow-lg shadow-emerald-950 flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Phone className="w-4 h-4" />
                <span>Accept Call & Connect Now</span>
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
};

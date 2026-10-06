import React, { useState, useEffect } from 'react';
import { 
  X, 
  Flame, 
  Phone, 
  MessageSquare, 
  Calendar, 
  Pause, 
  Play, 
  UserCheck, 
  MapPin, 
  DollarSign, 
  Clock, 
  Home, 
  Sparkles, 
  CheckCircle2, 
  RotateCw, 
  Send, 
  Share2, 
  History, 
  ShieldCheck,
  Building2,
  FileText,
  Volume2
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { AssignAgentControl } from '../leads/AssignAgentControl';
import { Lead, Channel } from '../../types';
import { getLeadFlow, type LeadFlow } from '../../utils/assistantApi';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LeadDetailModal: React.FC = () => {
  const { 
    selectedLeadId, 
    setSelectedLeadId, 
    findLead, 
    conversations, 
    calls, 
    appointments, 
    auditLogs, 
    sendSmsMessage, 
    toggleAutomation, 
    takeOverConversation, 
    bookAppointment, 
    startLiveCallSimulation, 
    setPreCallLeadId,
    orgSettings,
    agents 
  } = useApp();

  const [activeTab, setActiveTab] = useState<'overview' | 'conversation' | 'calls' | 'appointments' | 'audit'>('overview');
  const [smsInput, setSmsInput] = useState('');

  // The assignment just made from this modal, shown at once rather than after
  // the pipeline's refetch lands. Cleared when a different lead is opened.
  const [assigned, setAssigned] = useState<{ id: string; name: string } | null>(null);

  // Where the lead is in its journey (strategy step vs follow-up), from the API.
  const [flow, setFlow] = useState<LeadFlow | null>(null);
  useEffect(() => {
    setAssigned(null);
    setFlow(null);
    if (!selectedLeadId) return;
    let alive = true;
    getLeadFlow(selectedLeadId).then((f) => { if (alive) setFlow(f); }).catch(() => {});
    return () => { alive = false; };
  }, [selectedLeadId]);

  if (!selectedLeadId) return null;

  // findLead, not leads.find: a lead opened from the pipeline lives in Postgres,
  // not in the demo store.
  const lead = findLead(selectedLeadId);
  if (!lead) return null;

  const conversation = conversations[lead.id];
  const leadCalls = calls.filter(c => c.leadId === lead.id);
  const leadAppointments = appointments.filter(a => a.leadId === lead.id);
  const leadLogs = auditLogs.filter(log => log.entityId === lead.id);
  const assignedAgent = agents.find(a => a.id === lead.assignedAgentId) || agents[0];

  // A database lead carries its real assignment; only a demo-store lead is
  // resolved against the demo roster. Told apart by id, because the same
  // database lead can reach here through either of two loaders (see findLead),
  // and only a database row has a UUID — demo leads are `lead_<timestamp>`.
  const isLive = UUID.test(lead.id);
  const liveAgent =
    assigned ?? (lead.assignedAgentId && lead.assignedAgentName ? { id: lead.assignedAgentId, name: lead.assignedAgentName } : null);
  const agentLabel = isLive
    ? liveAgent?.name ?? 'Unassigned'
    : lead.assignedAgentId ? assignedAgent.name : 'Unassigned';

  const handleSendSms = (e: React.FormEvent) => {
    e.preventDefault();
    if (!smsInput.trim()) return;
    sendSmsMessage(lead.id, smsInput.trim(), 'agent');
    setSmsInput('');
  };

  const handleBookQuickConsult = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    bookAppointment({
      organizationId: orgSettings.id,
      leadId: lead.id,
      leadName: `${lead.firstName} ${lead.lastName}`,
      agentId: assignedAgent.id,
      agentName: assignedAgent.name,
      provider: 'calendly',
      startTime: tomorrow.toISOString(),
      endTime: new Date(tomorrow.getTime() + 30 * 60000).toISOString(),
      status: 'scheduled',
      appointmentType: 'Buyer Consultation',
      locationOrLink: 'https://meet.google.com/aus-home-consult',
      notes: 'Consultation scheduled directly from lead detail dossier.',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] text-slate-100">
        
        {/* Header (PRD Section 38: Name, HOT - 87, Actions) */}
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg text-white ${
              lead.temperature === 'hot' 
                ? 'bg-gradient-to-tr from-amber-600 to-rose-600 shadow-md shadow-rose-950' 
                : lead.temperature === 'warm'
                ? 'bg-gradient-to-tr from-amber-600 to-yellow-500'
                : 'bg-slate-800 text-slate-400'
            }`}>
              {lead.firstName[0]}{lead.lastName[0]}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-white">{lead.firstName} {lead.lastName}</h2>
                <span className={`text-xs uppercase font-extrabold px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                  lead.temperature === 'hot'
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                    : lead.temperature === 'warm'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/30'
                }`}>
                  {lead.temperature === 'hot' && <Flame className="w-3.5 h-3.5 text-rose-400" />}
                  {lead.temperature.toUpperCase()} — SCORE {lead.score}
                </span>

                <span className="text-[11px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {lead.status.replace('_', ' ')}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                <span>{lead.phone}</span>
                <span>•</span>
                <span>{lead.email}</span>
                <span>•</span>
                <span className="text-slate-300 font-medium">
                  Agent: {agentLabel}
                </span>
                <span>•</span>
                <span className="text-emerald-400 font-medium">Source: {lead.source}</span>
              </div>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2">
            {isLive && (
              <AssignAgentControl leadId={lead.id} current={liveAgent} onAssigned={setAssigned} />
            )}

            <button
              onClick={() => startLiveCallSimulation(lead)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
            >
              <Phone className="w-3.5 h-3.5" />
              <span>Voice AI Call</span>
            </button>

            {lead.temperature === 'hot' && (
              <button
                onClick={() => setPreCallLeadId(lead.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-medium transition-colors cursor-pointer"
              >
                <Flame className="w-3.5 h-3.5 text-rose-400" />
                <span>Pre-Call Screen</span>
              </button>
            )}

            <button
              onClick={() => toggleAutomation(lead.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                lead.automationPaused 
                  ? 'bg-amber-950 text-amber-300 border-amber-700/60' 
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
              }`}
            >
              {lead.automationPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{lead.automationPaused ? 'Resume AI' : 'Pause AI'}</span>
            </button>

            <button
              onClick={() => setSelectedLeadId(null)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Flow status — where this lead is in its journey (strategy step vs follow-up) */}
        {flow && (
          <div className="px-5 py-2.5 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <span className="text-[10px] uppercase font-bold tracking-wide text-slate-500">Flow</span>
            {(() => {
              const map = {
                strategy: { label: 'In Strategy', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
                exited: { label: 'Exited Strategy', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
                done: { label: 'Completed', cls: 'bg-slate-700/40 text-slate-300 border-slate-600/50' },
                not_started: { label: 'Not started', cls: 'bg-slate-800 text-slate-400 border-slate-700' },
              } as const;
              const m = map[flow.phase];
              return <span className={`px-2 py-0.5 rounded-full border font-bold uppercase text-[10px] ${m.cls}`}>{m.label}</span>;
            })()}

            {/* The real-world outcome (SMS sent / Call answered / Exited …) */}
            <span className="font-semibold text-slate-200">{flow.outcome}</span>

            {flow.phase === 'strategy' && flow.steps.length > 0 && (
              <>
                <span className="text-slate-400">{flow.strategyName}</span>
                <div className="flex items-center gap-1">
                  {flow.steps.map((s) => {
                    const name = s.channel === 'voice' ? 'Call' : 'SMS';
                    const cls =
                      s.state === 'done' ? 'bg-emerald-900/50 text-emerald-300 border-emerald-800/50'
                      : s.state === 'failed' ? 'bg-rose-900/40 text-rose-300 border-rose-800/50'
                      : s.state === 'current' ? 'bg-emerald-500 text-white border-emerald-400 shadow shadow-emerald-950'
                      : 'bg-slate-800 text-slate-500 border-slate-700';
                    return (
                      <span key={s.index} title={`Step ${s.index + 1}: ${s.action}${s.outcome ? ` — ${s.outcome}` : ''}`} className={`px-2 py-0.5 rounded-md border text-[10px] font-semibold ${cls}`}>
                        {s.index + 1}·{s.outcome ?? name}
                      </span>
                    );
                  })}
                </div>
                {flow.currentStep ? (
                  <span className="text-emerald-300 font-medium">
                    Current: Step {flow.currentStep.index + 1} of {flow.stepsTotal} — {flow.currentStep.channel === 'voice' ? 'AI Call' : 'SMS'}
                  </span>
                ) : (
                  <span className="text-slate-400">All {flow.stepsTotal} steps sent — awaiting outcome</span>
                )}
                {flow.reason && (
                  <span className="text-slate-500" title={flow.reason}>· last attempt: {flow.reason.replace(/\s+/g, ' ').slice(0, 45)}</span>
                )}
              </>
            )}

            {flow.phase === 'exited' && (
              <span className="text-rose-300" title={flow.reason ?? undefined}>
                Left the strategy — not reached{flow.reason ? `: ${flow.reason.replace(/\s+/g, ' ').slice(0, 80)}` : ''}
              </span>
            )}
            {flow.phase === 'not_started' && <span className="text-slate-500">Waiting to enter the strategy</span>}
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 px-5 bg-slate-950/40 gap-4 text-xs font-medium">
          {[
            { id: 'overview', label: 'Overview & Qualification' },
            { id: 'conversation', label: `SMS & Chat (${conversation?.messages.length || 0})` },
            { id: 'calls', label: `Voice Calls (${leadCalls.length})` },
            { id: 'appointments', label: `Appointments (${leadAppointments.length})` },
            { id: 'audit', label: `Audit Trail (${leadLogs.length})` },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`py-3 border-b-2 transition-colors cursor-pointer ${
                activeTab === tab.id 
                  ? 'border-emerald-500 text-emerald-400 font-semibold' 
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content Container */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              
              {/* Top Highlights Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                    <DollarSign className="w-4 h-4 text-emerald-400" />
                    <span>Budget Range</span>
                  </div>
                  <div className="text-base font-bold text-emerald-300 font-mono">
                    {lead.budgetMin || lead.budgetMax
                      ? `$${(lead.budgetMin / 1000).toFixed(0)}K – $${(lead.budgetMax / 1000).toFixed(0)}K`
                      : '—'}
                  </div>
                  <span className="text-[10px] text-slate-500">Confirmed in AI conversation</span>
                </div>

                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                    <MapPin className="w-4 h-4 text-cyan-400" />
                    <span>Target Location</span>
                  </div>
                  <div className="text-base font-bold text-slate-200 truncate">
                    {lead.preferredLocation || '—'}
                  </div>
                  <span className="text-[10px] text-slate-500">Target area verified</span>
                </div>

                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                    <Clock className="w-4 h-4 text-amber-400" />
                    <span>Buying Timeline</span>
                  </div>
                  <div className="text-base font-bold text-slate-200">
                    {lead.timeline || '—'}
                  </div>
                  <span className="text-[10px] text-slate-500">High priority urgency</span>
                </div>

                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                    <Home className="w-4 h-4 text-purple-400" />
                    <span>Bedrooms & Spec</span>
                  </div>
                  <div className="text-base font-bold text-slate-200">
                    {lead.bedrooms ? `${lead.bedrooms} Beds` : '—'}
                    {lead.propertyType ? ` (${lead.propertyType})` : ''}
                  </div>
                  <span className="text-[10px] text-slate-500">Single family preference</span>
                </div>
              </div>

              {/* AI Score Reasoning Breakdown (PRD Section 26) */}
              <div className="bg-slate-950/80 border border-slate-800 p-5 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      Deterministic Lead Score Breakdown ({lead.score}/100)
                    </h4>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">
                    Updated: {new Date(lead.updatedAt).toLocaleTimeString()}
                  </span>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  {lead.scoreBreakdown?.reasoningSummary || 'Lead scored based on confirmed budget, timeline, location alignment, and responsiveness.'}
                </p>

                {/* Score Rules Badges */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-2 border-t border-slate-800">
                  {lead.scoreBreakdown?.rulesApplied.map((rule, idx) => (
                    <div key={idx} className="bg-slate-900 border border-slate-800/80 p-2 rounded-lg flex items-center justify-between text-xs">
                      <span className="text-slate-300 truncate pr-2">{rule.rule}</span>
                      <span className="text-emerald-400 font-bold font-mono shrink-0">+{rule.points}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Financing, Motivation & CRM Status */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-cyan-400" />
                    Financing & Pre-Approval
                  </h4>
                  <div className="text-xs text-slate-200 bg-slate-900 p-3 rounded-lg border border-slate-800">
                    {lead.financingStatus || '—'}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Pre-approval Status: <strong className={lead.preapprovalStatus ? 'text-emerald-400' : 'text-amber-400'}>
                      {lead.preapprovalStatus ? 'Verified Pre-Approved' : 'Needs Lender Connection'}
                    </strong>
                  </div>
                </div>

                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <Building2 className="w-4 h-4 text-emerald-400" />
                    CRM & Pipeline Status
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Follow Up Boss ID:</span>
                      <span className="font-mono text-emerald-400">FUB-{lead.id.substring(5, 12)}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Next Scheduled Action:</span>
                      <span className="text-amber-300">{lead.nextFollowupAt || 'None scheduled'}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Communication Opt-in:</span>
                      <span className="text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> 10DLC SMS & Voice Consent
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Everything the prospect said that has no field of its own.
                  Kept out of the pipeline table on purpose — that shows only
                  what we act on — but never discarded. */}
              {lead.customFields && Object.keys(lead.customFields).length > 0 && (
                <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-slate-400" />
                    Other answers from the form
                  </h4>
                  <p className="text-[11px] text-slate-500">
                    Captured verbatim. These did not match one of our lead fields, so they are kept
                    here rather than dropped.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
                    {Object.entries(lead.customFields).map(([k, v]) => (
                      <div key={k} className="flex items-baseline gap-2 text-xs">
                        <span className="text-slate-500 min-w-[40%] shrink-0 truncate" title={k}>
                          {k}
                        </span>
                        <span className="text-slate-200 break-words">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick Consultation Booking Bar */}
              <div className="bg-gradient-to-r from-emerald-950/40 via-teal-950/40 to-slate-950 border border-emerald-500/30 p-4 rounded-xl flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-emerald-300">Fast Buyer Consultation Booking</h4>
                  <p className="text-[11px] text-slate-400">Synchronizes with Alex Vance's Calendly and pauses cold follow-up tasks.</p>
                </div>
                <button
                  onClick={handleBookQuickConsult}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-md transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <Calendar className="w-3.5 h-3.5" />
                  <span>Book Consultation for Tomorrow 10 AM</span>
                </button>
              </div>

            </div>
          )}

          {/* TAB 2: CONVERSATION (SMS / Chat) */}
          {activeTab === 'conversation' && (
            <div className="flex flex-col h-[460px] bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
              <div className="p-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="font-semibold text-slate-200">Twilio SMS Thread with {lead.firstName} ({lead.phone})</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => takeOverConversation(lead.id)}
                    className="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    Take Over (Human Handoff)
                  </button>
                </div>
              </div>

              {/* Messages Container */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                {conversation && conversation.messages.length > 0 ? (
                  conversation.messages.map(msg => {
                    const isLead = msg.sender === 'lead';
                    const isAi = msg.sender === 'ai';
                    return (
                      <div key={msg.id} className={`flex flex-col ${isLead ? 'items-start' : 'items-end'}`}>
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mb-0.5 px-1">
                          <span className="font-semibold text-slate-300">
                            {isAi ? `${orgSettings.aiAgentName} (AI)` : isLead ? `${lead.firstName} ${lead.lastName}` : 'Agent (You)'}
                          </span>
                          <span>•</span>
                          <span>{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <div className={`p-3 rounded-2xl max-w-[80%] text-xs leading-relaxed ${
                          isLead 
                            ? 'bg-slate-800 text-slate-100 rounded-tl-sm border border-slate-700' 
                            : isAi 
                            ? 'bg-emerald-950/80 text-emerald-200 border border-emerald-800/60 rounded-tr-sm' 
                            : 'bg-emerald-600 text-white rounded-tr-sm shadow'
                        }`}>
                          {msg.content}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-slate-500">
                    No conversation messages logged yet. Send an SMS below.
                  </div>
                )}
              </div>

              {/* Send Box */}
              <form onSubmit={handleSendSms} className="p-3 bg-slate-900 border-t border-slate-800 flex items-center gap-2">
                <input
                  type="text"
                  value={smsInput}
                  onChange={(e) => setSmsInput(e.target.value)}
                  placeholder={`Text ${lead.firstName} directly via Twilio...`}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="submit"
                  disabled={!smsInput.trim()}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                </button>
              </form>
            </div>
          )}

          {/* TAB 3: VOICE CALLS */}
          {activeTab === 'calls' && (
            <div className="space-y-4">
              {leadCalls.length > 0 ? (
                leadCalls.map(call => (
                  <div key={call.id} className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                          <Phone className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>Retell Voice Call ({call.direction.toUpperCase()})</span>
                            <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 font-mono">
                              {call.outcome}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-400">
                            Duration: {Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s • {new Date(call.startedAt).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 text-xs text-cyan-400 font-mono">
                        <Volume2 className="w-4 h-4" />
                        <span>Audio Logged</span>
                      </div>
                    </div>

                    <div className="bg-slate-900 border border-slate-800/80 p-3 rounded-lg text-xs text-slate-300 space-y-1">
                      <div className="font-semibold text-slate-200">AI Call Summary:</div>
                      <p className="leading-relaxed">{call.summary}</p>
                    </div>

                    {/* Transcript Accordion */}
                    <div className="space-y-2 pt-1">
                      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                        Call Transcript ({call.transcript.length} turns)
                      </div>
                      <div className="max-h-48 overflow-y-auto space-y-2 bg-slate-900/50 p-3 rounded-lg border border-slate-800/60 custom-scrollbar">
                        {call.transcript.map((t, idx) => (
                          <div key={idx} className="text-xs flex gap-2">
                            <span className="font-semibold text-emerald-400 w-20 shrink-0 font-mono text-[11px]">{t.speaker}:</span>
                            <span className="text-slate-300">{t.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center bg-slate-950 border border-slate-800 rounded-xl space-y-3">
                  <Phone className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-xs text-slate-400">No voice calls recorded yet for this lead.</p>
                  <button
                    onClick={() => startLiveCallSimulation(lead)}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    Start Simulated AI Call
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: APPOINTMENTS */}
          {activeTab === 'appointments' && (
            <div className="space-y-4">
              {leadAppointments.length > 0 ? (
                leadAppointments.map(appt => (
                  <div key={appt.id} className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center">
                        <Calendar className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-bold text-white">{appt.appointmentType}</h4>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 font-mono">
                            {appt.status.toUpperCase()}
                          </span>
                        </div>
                        <div className="text-xs text-slate-300 mt-0.5">
                          {new Date(appt.startTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                        </div>
                        <div className="text-[11px] text-slate-400">Agent: {appt.agentName}</div>
                      </div>
                    </div>

                    <a
                      href={appt.locationOrLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
                    >
                      Join Meeting Link
                    </a>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center bg-slate-950 border border-slate-800 rounded-xl space-y-3">
                  <Calendar className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-xs text-slate-400">No appointments currently booked.</p>
                  <button
                    onClick={handleBookQuickConsult}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    Schedule Buyer Consultation
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 5: AUDIT TRAIL (PRD Section 55) */}
          {activeTab === 'audit' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400 mb-2">
                Chronological event trail tracking lead capture, automated triggers, score adjustments, and CRM sync:
              </div>
              <div className="relative pl-6 border-l border-slate-800 space-y-4">
                {leadLogs.map(log => (
                  <div key={log.id} className="relative group">
                    <div className="absolute -left-[31px] top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-slate-900" />
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-bold text-slate-200">{log.action}</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                        {log.actor}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{log.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  );
};

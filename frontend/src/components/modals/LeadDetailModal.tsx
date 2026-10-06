import React, { useState, useEffect } from 'react';
import {
  X,
  Flame,
  Phone,
  MessageSquare,
  Calendar,
  MapPin,
  DollarSign,
  Clock,
  Home,
  ShieldCheck,
  FileText,
  ChevronDown,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { enrollLead, getLeadFlow, type LeadFlow } from '../../utils/assistantApi';
import {
  getCall,
  listCalls,
  listConversations,
  listMessages,
  type CallDetail,
  type CallRow,
  type MessageRow,
} from '../../utils/historyApi';
import { listAppointments, type Appointment as CalendarAppointment } from '../../utils/calendarApi';
import { OUTCOME_STYLES, duration } from '../views/CallsView';
import { messageFor } from '../../lib/api';

interface LeadActivity {
  calls: CallRow[];
  messages: MessageRow[];
  appointments: CalendarAppointment[];
}

/**
 * Everything that actually happened with one lead.
 *
 * ponytail: these endpoints have no lead filter yet, so this reads the office's
 * most recent 200 calls / conversations and filters here. Add `?leadId=` to the
 * history and appointment endpoints when an office outgrows that window.
 */
async function loadLeadActivity(leadId: string): Promise<LeadActivity> {
  const [calls, conversations, appointments] = await Promise.all([
    listCalls({ limit: 200 }),
    listConversations(200),
    listAppointments(),
  ]);
  const threads = conversations.filter((c) => c.leadId === leadId && c.channel === 'sms');
  const messages = (await Promise.all(threads.map((c) => listMessages(c.id))))
    .flat()
    .sort((a, b) => Date.parse(a.sentAt ?? a.createdAt) - Date.parse(b.sentAt ?? b.createdAt));
  return {
    calls: calls.filter((c) => c.leadId === leadId),
    messages,
    appointments: appointments.filter((a) => a.leadId === leadId),
  };
}

const EmptyTab: React.FC<{ icon: React.ReactNode; text: string }> = ({ icon, text }) => (
  <div className="py-12 text-center space-y-2">
    <div className="w-12 h-12 mx-auto rounded-xl bg-slate-800/70 text-slate-500 flex items-center justify-center">{icon}</div>
    <p className="text-sm text-slate-400">{text}</p>
  </div>
);

/** One call; the transcript and summary are fetched only when it is opened. */
const CallItem: React.FC<{ call: CallRow }> = ({ call }) => {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen((o) => !o);
    if (!detail && !error) getCall(call.id).then(setDetail).catch((e) => setError(messageFor(e)));
  };
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden">
      <button onClick={toggle} className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:bg-slate-800/40 transition-colors cursor-pointer">
        <div className="w-9 h-9 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
          <Phone className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-100 capitalize">{call.direction} call</span>
            <span className={`text-2xs font-semibold px-2 py-0.5 rounded-full border ${OUTCOME_STYLES[call.outcome]}`}>
              {call.outcome.replace(/_/g, ' ').toLowerCase()}
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            {new Date(call.startedAt ?? call.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            {' · '}
            {duration(call.durationSeconds)}
            {call.agentName && ` · ${call.agentName}`}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-slate-800">
          {call.recordingUrl && <audio controls src={call.recordingUrl} className="w-full h-9 mt-2" />}
          {error ? (
            <p className="text-xs text-rose-300">Could not load this call: {error}</p>
          ) : !detail ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : (
            <>
              <div>
                <div className="text-xs font-semibold text-slate-400 mb-1">Summary</div>
                <p className="text-sm text-slate-200 leading-relaxed">{detail.aiSummary || 'No summary was recorded for this call.'}</p>
              </div>
              {detail.transcript && (
                <div>
                  <div className="text-xs font-semibold text-slate-400 mb-1">Transcript</div>
                  <pre className="max-h-56 overflow-y-auto custom-scrollbar whitespace-pre-wrap font-sans text-xs text-slate-300 leading-relaxed bg-slate-900 border border-slate-800 rounded-lg p-3">
                    {detail.transcript}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const LeadDetailModal: React.FC = () => {
  const {
    selectedLeadId,
    setSelectedLeadId,
    findLead,
    setPreCallLeadId,
    agents
  } = useApp();

  const [activeTab, setActiveTab] = useState<'overview' | 'conversation' | 'calls' | 'appointments'>('overview');

  // Where the lead is in its journey (strategy step vs follow-up), from the API.
  const [flow, setFlow] = useState<LeadFlow | null>(null);
  useEffect(() => {
    setFlow(null);
    if (!selectedLeadId) return;
    let alive = true;
    getLeadFlow(selectedLeadId).then((f) => { if (alive) setFlow(f); }).catch(() => {});
    return () => { alive = false; };
  }, [selectedLeadId]);

  // The lead's real activity: calls, SMS and appointments from the API.
  const [activity, setActivity] = useState<LeadActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  useEffect(() => {
    setActivity(null);
    setActivityError(null);
    if (!selectedLeadId) return;
    let alive = true;
    loadLeadActivity(selectedLeadId)
      .then((a) => { if (alive) setActivity(a); })
      .catch((e) => { if (alive) setActivityError(messageFor(e)); });
    return () => { alive = false; };
  }, [selectedLeadId]);

  // Esc closes the dossier, like every other dialog.
  useEffect(() => {
    if (!selectedLeadId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedLeadId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLeadId, setSelectedLeadId]);

  // Real outreach: enrols the lead into the office's strategy (call/SMS via Telnyx).
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const startOutreach = async () => {
    if (!selectedLeadId) return;
    setEnrolling(true);
    setEnrollError(null);
    try {
      await enrollLead(selectedLeadId);
      setFlow(await getLeadFlow(selectedLeadId));
    } catch (e) {
      setEnrollError(messageFor(e));
    } finally {
      setEnrolling(false);
    }
  };

  if (!selectedLeadId) return null;

  // findLead, not leads.find: a lead opened from the pipeline lives in Postgres,
  // not in the demo store.
  const lead = findLead(selectedLeadId);
  if (!lead) return null;

  const assignedAgent = agents.find(a => a.id === lead.assignedAgentId) || agents[0];
  const count = (n: number | undefined) => (activity ? ` (${n})` : '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] text-slate-100">
        
        {/* Header (PRD Section 38: Name, HOT - 87, Actions) */}
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg ${
              lead.temperature === 'hot'
                ? 'bg-gradient-to-tr from-amber-600 to-rose-600 shadow-md shadow-rose-950 text-on-accent'
                : lead.temperature === 'warm'
                ? 'bg-gradient-to-tr from-amber-600 to-yellow-500 text-on-accent'
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
                  {lead.temperature.toUpperCase()}
                </span>

                <span className="text-xs uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {lead.status.replace('_', ' ')}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                {/* Only the parts the lead has, so there is never a stray separator. */}
                {[
                  lead.phone && <span key="p">{lead.phone}</span>,
                  lead.email && <span key="e">{lead.email}</span>,
                  <span key="a" className="text-slate-300 font-medium">
                    Agent: {lead.assignedAgentId ? assignedAgent.name : 'Unassigned'}
                  </span>,
                  <span key="s" className="text-emerald-400 font-medium">Source: {lead.source}</span>,
                ]
                  .filter(Boolean)
                  .flatMap((part, i) => (i === 0 ? [part] : [<span key={`d${i}`} className="text-slate-600">•</span>, part]))}
              </div>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2">
            {/* Only offered while the strategy has not started: once it has, the
                server ignores a second enrol, so the button would do nothing. */}
            {flow?.phase === 'not_started' && (
              <button
                onClick={() => void startOutreach()}
                disabled={enrolling}
                title={enrollError ?? 'Start the outbound strategy (AI call / SMS) for this lead now'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold shadow-sm transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                <Phone className="w-3.5 h-3.5" />
                <span>{enrolling ? 'Starting…' : enrollError ? 'Retry AI Outreach' : 'Start AI Outreach'}</span>
              </button>
            )}

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
            <span className="text-2xs uppercase font-bold tracking-wide text-slate-500">Flow</span>
            {(() => {
              const map = {
                strategy: { label: 'In Strategy', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
                exited: { label: 'Exited Strategy', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
                done: { label: 'Completed', cls: 'bg-slate-700/40 text-slate-300 border-slate-600/50' },
                not_started: { label: 'Not started', cls: 'bg-slate-800 text-slate-400 border-slate-700' },
              } as const;
              const m = map[flow.phase];
              return <span className={`px-2 py-0.5 rounded-full border font-bold uppercase text-2xs ${m.cls}`}>{m.label}</span>;
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
                      : s.state === 'current' ? 'bg-emerald-500 text-on-accent border-emerald-400 shadow shadow-emerald-950'
                      : 'bg-slate-800 text-slate-500 border-slate-700';
                    return (
                      <span key={s.index} title={`Step ${s.index + 1}: ${s.action}${s.outcome ? ` — ${s.outcome}` : ''}`} className={`px-2 py-0.5 rounded-md border text-2xs font-semibold ${cls}`}>
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
            { id: 'overview', label: 'Overview' },
            { id: 'conversation', label: `SMS${count(activity?.messages.length)}` },
            { id: 'calls', label: `AI Calls${count(activity?.calls.length)}` },
            { id: 'appointments', label: `Appointments${count(activity?.appointments.length)}` },
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
              
              {/* What the lead told us. Each value is a real field or an honest dash. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { icon: <DollarSign className="w-4 h-4 text-emerald-400" />, label: 'Budget', value: lead.budgetMin || lead.budgetMax ? `$${(lead.budgetMin / 1000).toFixed(0)}K – $${(lead.budgetMax / 1000).toFixed(0)}K` : '—' },
                  { icon: <MapPin className="w-4 h-4 text-cyan-400" />, label: 'Location', value: lead.preferredLocation || '—' },
                  { icon: <Clock className="w-4 h-4 text-amber-400" />, label: 'Timeline', value: lead.timeline || '—' },
                  { icon: <Home className="w-4 h-4 text-purple-400" />, label: 'Bedrooms', value: lead.bedrooms ? `${lead.bedrooms} beds${lead.propertyType ? ` · ${lead.propertyType}` : ''}` : '—' },
                ].map((f) => (
                  <div key={f.label} className="bg-slate-950/60 border border-slate-800 px-4 py-3.5 rounded-xl">
                    <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">
                      {f.icon}
                      <span>{f.label}</span>
                    </div>
                    <div className="text-sm font-semibold text-slate-100 truncate" title={f.value}>{f.value}</div>
                  </div>
                ))}
              </div>

              <div className="bg-slate-950/60 border border-slate-800 px-4 py-3.5 rounded-xl">
                <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <span>Financing</span>
                </div>
                <div className="text-sm text-slate-100">{lead.financingStatus || '—'}</div>
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
                  <p className="text-xs text-slate-500">
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


            </div>
          )}

          {/* Shared loading / error state for the three activity tabs. */}
          {activeTab !== 'overview' && !activity && (
            <div className="p-10 text-center text-xs text-slate-500">
              {activityError ? `Could not load activity: ${activityError}` : 'Loading activity…'}
            </div>
          )}

          {/* TAB 2: SMS — the real thread, newest at the bottom. Read-only: texts
              are sent by the strategy and follow-up sequences. */}
          {activeTab === 'conversation' && activity && (
            activity.messages.length > 0 ? (
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-3 max-h-[460px] overflow-y-auto custom-scrollbar">
                {activity.messages.map(msg => {
                  const inbound = msg.direction === 'inbound';
                  const failed = msg.deliveryStatus === 'failed';
                  return (
                    <div key={msg.id} className={`flex flex-col ${inbound ? 'items-start' : 'items-end'}`}>
                      <div className="text-2xs text-slate-500 mb-1 px-1">
                        {inbound ? lead.firstName : msg.senderType === 'ai' ? 'AI assistant' : 'Agent'}
                        {' · '}
                        {new Date(msg.sentAt ?? msg.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                        {failed && <span className="text-rose-400 font-semibold"> · not delivered</span>}
                      </div>
                      <div className={`px-3.5 py-2.5 rounded-2xl max-w-[80%] text-sm leading-relaxed whitespace-pre-wrap ${
                        inbound
                          ? 'bg-slate-800 text-slate-100 rounded-tl-sm'
                          : failed
                          ? 'bg-rose-500/10 text-rose-200 border border-rose-500/30 rounded-tr-sm'
                          : 'bg-emerald-500/15 text-emerald-100 border border-emerald-500/25 rounded-tr-sm'
                      }`}>
                        {msg.body}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyTab icon={<MessageSquare className="w-6 h-6" />} text="No texts with this lead yet." />
            )
          )}

          {/* TAB 3: AI CALLS — every call placed or received, transcript on demand. */}
          {activeTab === 'calls' && activity && (
            activity.calls.length > 0 ? (
              <div className="space-y-2.5">
                {activity.calls.map(call => <CallItem key={call.id} call={call} />)}
              </div>
            ) : (
              <EmptyTab icon={<Phone className="w-6 h-6" />} text="No AI calls with this lead yet." />
            )
          )}

          {/* TAB 4: APPOINTMENTS — synced from the office calendar. */}
          {activeTab === 'appointments' && activity && (
            activity.appointments.length > 0 ? (
              <div className="space-y-2.5">
                {activity.appointments.map(appt => (
                  <div key={appt.id} className="bg-slate-950/60 border border-slate-800 px-4 py-3.5 rounded-xl flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                        <Calendar className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-100 truncate">{appt.appointmentType || 'Appointment'}</span>
                          <span className="text-2xs font-semibold capitalize px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                            {appt.status.replace('_', ' ')}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {new Date(appt.startTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {appt.agentName}
                        </div>
                      </div>
                    </div>
                    {appt.meetingUrl && (
                      <a
                        href={appt.meetingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors shrink-0"
                      >
                        Join meeting
                      </a>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyTab icon={<Calendar className="w-6 h-6" />} text="No appointments booked with this lead." />
            )
          )}

        </div>

      </div>
    </div>
  );
};

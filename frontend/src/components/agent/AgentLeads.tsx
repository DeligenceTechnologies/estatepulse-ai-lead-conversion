import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, Mail, Phone, RefreshCw, X } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { LeadAppointments } from '../leads/LeadBooking';
import {
  getMyLead,
  getMyLeads,
  leadName,
  type AgentLead,
  type AgentLeadDetail,
} from '../../utils/agentMeApi';
import { statusLabel, statusTone } from '../../lib/leadStatus';

/** Same tones the owner's pipeline uses, so one lead reads the same on both screens. */
const TEMPERATURE_TONE: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
};


const NEUTRAL = 'bg-slate-800 text-slate-400 border-slate-700';
const PILL = 'text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border font-mono';
const DASH = '—';

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : DASH);
const humanize = (v: string): string => v.replace(/_/g, ' ');
const money = (n: number | null): string => (n === null ? DASH : `$${n.toLocaleString()}`);

/** One labelled value in the detail modal. Renders a dash rather than nothing. */
const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
    <span className="text-slate-400 block text-[10px]">{label}</span>
    <span className="text-slate-100 break-words">{value === null || value === '' ? DASH : value}</span>
  </div>
);

/**
 * The lead the agent clicked, fetched on its own so the detail is always the
 * server's current answer rather than a copy of the list row.
 *
 * Read-only by design for this phase: there is no safe existing endpoint for an
 * agent to edit a lead, and inventing one is a different piece of work.
 */
const LeadDetailModal: React.FC<{ leadId: string; onClose: () => void }> = ({ leadId, onClose }) => {
  const [lead, setLead] = useState<AgentLeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyLead(leadId)
      .then((l) => {
        if (!cancelled) setLead(l);
      })
      .catch((e) => {
        if (!cancelled) setError(messageFor(e));
      });
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100 max-h-[90vh] flex flex-col">
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white truncate">
              {lead ? leadName(lead) : 'Lead'}
            </h3>
            {lead && (
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`${PILL} ${statusTone(lead.status)}`}>
                  {statusLabel(lead.status)}
                </span>
                {lead.temperature && (
                  <span className={`${PILL} ${TEMPERATURE_TONE[lead.temperature] ?? NEUTRAL}`}>
                    {lead.temperature}
                  </span>
                )}
                {lead.dncStatus && (
                  <span className={`${PILL} bg-rose-500/20 text-rose-300 border-rose-500/40`}>
                    Do not contact
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs overflow-y-auto custom-scrollbar">
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
              <span className="text-rose-200 leading-relaxed">{error}</span>
            </div>
          )}

          {!lead && !error && (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading lead…
            </div>
          )}

          {lead && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Phone" value={lead.phone} />
                <Field label="Email" value={lead.email} />
                <Field label="Source" value={lead.source?.name ?? null} />
                <Field label="Consent" value={humanize(lead.consentStatus)} />
                <Field label="Created" value={formatDate(lead.createdAt)} />
                <Field label="Assigned to you" value={formatDate(lead.assignedAt)} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Location" value={lead.location} />
                <Field label="Timeline" value={lead.timeline} />
                <Field label="Buying intent" value={lead.buyingIntent} />
                <Field
                  label="Budget"
                  value={
                    lead.minBudget === null && lead.maxBudget === null
                      ? null
                      : `${money(lead.minBudget)} – ${money(lead.maxBudget)}`
                  }
                />
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800 space-y-1">
                <span className="text-slate-400 block text-[10px]">Motivation</span>
                <p className="text-slate-100 leading-relaxed">{lead.motivation ?? DASH}</p>
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800 space-y-1">
                <span className="text-slate-400 block text-[10px]">Latest AI note</span>
                <p className="text-slate-100 leading-relaxed">{lead.aiSummary ?? DASH}</p>
              </div>

              <LeadAppointments leadId={lead.id} agentKey={null} />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The agent's own leads.
 *
 * The list is whatever `/agents/me/leads` returns, which is only what is
 * currently assigned to them. There is no filter for "everyone else's leads"
 * because there is no way to ask for them.
 */
export const AgentLeads: React.FC = () => {
  const [leads, setLeads] = useState<AgentLead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLeads(await getMyLeads());
      setError(null);
    } catch (e) {
      setError(messageFor(e));
      setLeads([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto text-slate-100">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">My Leads</h2>
          <p className="text-xs text-slate-400">Leads currently assigned to you.</p>
        </div>
        <button
          onClick={() => void load()}
          className="px-3 py-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${leads === null ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Something went wrong</div>
            {error}
          </div>
        </div>
      )}

      {leads === null ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 text-xs text-slate-400 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your leads…
        </div>
      ) : leads.length === 0 ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
          <Inbox className="w-6 h-6 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto">
            No leads are assigned to you yet.
            {/* Honest about the cause: the assignment table is real and empty,
                because automatic routing is a later phase. */}
            <span className="block text-slate-500 mt-1">
              Leads appear here once your office assigns them to you.
            </span>
          </div>
        </div>
      ) : (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-xs">
              <thead className="bg-slate-950/60 text-slate-400">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Lead</th>
                  <th className="text-left font-semibold px-4 py-2.5">Contact</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-left font-semibold px-4 py-2.5">Source</th>
                  <th className="text-left font-semibold px-4 py-2.5">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {leads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => setOpenLeadId(lead.id)}
                    className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-white">{leadName(lead)}</div>
                      {lead.temperature && (
                        <span
                          className={`${PILL} ${TEMPERATURE_TONE[lead.temperature] ?? NEUTRAL} mt-1 inline-block`}
                        >
                          {lead.temperature}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <Phone className="w-3 h-3 text-slate-500 shrink-0" />
                        <span className="font-mono">{lead.phone ?? DASH}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Mail className="w-3 h-3 text-slate-500 shrink-0" />
                        <span className="truncate max-w-[200px] inline-block">{lead.email ?? DASH}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`${PILL} ${statusTone(lead.status)}`}>
                        {statusLabel(lead.status)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{lead.source?.name ?? DASH}</td>
                    <td className="px-4 py-2.5 text-slate-400 font-mono">
                      {formatDate(lead.assignedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openLeadId && <LeadDetailModal leadId={openLeadId} onClose={() => setOpenLeadId(null)} />}
    </div>
  );
};

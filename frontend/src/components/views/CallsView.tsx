import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  FileText,
  PhoneCall,
  PhoneOff,
  RotateCw,
  Search,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { listMembers, type OrganizationMember } from '../../utils/agentsApi';
import {
  getCall,
  listCalls,
  type CallDetail,
  type CallOutcome,
  type CallRow,
} from '../../utils/historyApi';

/**
 * Call history for the office.
 *
 * This screen used to render `mockData` out of localStorage, complete with a
 * fake waveform and a hardcoded "Provider: Retell" badge. Everything here is
 * now the real `voice_calls` table: the recording and transcript arrive from
 * the Telnyx webhooks (call.recording.saved / .transcription.saved), and what
 * a caller may see is decided server-side by role.
 *
 * The audio element is a plain <audio controls>. A custom player would have to
 * reimplement scrubbing, buffering and keyboard access to look slightly nicer
 * than the one every browser already ships.
 */

const OUTCOME_STYLES: Record<CallOutcome, string> = {
  APPOINTMENT_BOOKED: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  QUALIFIED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  HUMAN_HANDOFF: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  ANSWERED: 'bg-slate-700/60 text-slate-200 border-slate-600',
  IN_PROGRESS: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  NO_ANSWER: 'bg-slate-800 text-slate-400 border-slate-700',
  NOT_INTERESTED: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  FAILED: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
};

const OUTCOMES: CallOutcome[] = [
  'ANSWERED',
  'NO_ANSWER',
  'QUALIFIED',
  'APPOINTMENT_BOOKED',
  'HUMAN_HANDOFF',
  'NOT_INTERESTED',
  'IN_PROGRESS',
  'FAILED',
];

const TEMP_STYLES: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
};

const duration = (s: number | null): string => {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r < 10 ? '0' : ''}${r}s`;
};

const selectClass =
  'bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-600';

export const CallsView: React.FC = () => {
  const { setSelectedLeadId } = useApp();

  const [q, setQ] = useState('');
  // Applied separately from `q` so the list is not refetched on every keystroke.
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('');
  const [temperature, setTemperature] = useState('');
  const [agentId, setAgentId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agents, setAgents] = useState<OrganizationMember[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // An agent cannot list the office's members; the filter is an owner's tool
  // and its absence is not an error worth showing.
  useEffect(() => {
    void listMembers()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  const fetchCalls = useCallback(
    () =>
      listCalls({
        q: search || undefined,
        outcome: outcome || undefined,
        temperature: temperature || undefined,
        agentId: agentId || undefined,
        // Dates arrive as yyyy-mm-dd; widen `to` to the end of that day, or a
        // filter of "today to today" would match nothing.
        from: from || undefined,
        to: to ? `${to}T23:59:59.999Z` : undefined,
      }),
    [search, outcome, temperature, agentId, from, to],
  );

  const callsQuery = useLiveQuery<CallRow[]>(fetchCalls, {
    refreshKey: `${search}|${outcome}|${temperature}|${agentId}|${from}|${to}`,
  });
  const calls = callsQuery.data ?? [];

  const fetchDetail = useCallback(
    () => (selectedId ? getCall(selectedId) : Promise.resolve(null)),
    [selectedId],
  );
  const detailQuery = useLiveQuery<CallDetail | null>(fetchDetail, { refreshKey: selectedId });
  const detail = detailQuery.data;

  // Keep a selection alive across refetches, but never point at a call the
  // current filters have excluded.
  useEffect(() => {
    if (calls.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !calls.some((c) => c.id === selectedId)) setSelectedId(calls[0].id);
  }, [calls, selectedId]);

  const clearFilters = () => {
    setQ('');
    setOutcome('');
    setTemperature('');
    setAgentId('');
    setFrom('');
    setTo('');
  };

  const filtered = outcome || temperature || agentId || from || to || search;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Call History</h2>
          <p className="text-xs text-slate-400">
            Every AI call this office has placed — recording, transcript and outcome.
          </p>
        </div>
        <button
          onClick={callsQuery.refresh}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RotateCw className={`w-3.5 h-3.5 ${callsQuery.refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {callsQuery.stale && (
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-950/40 border border-amber-800/40 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          Showing the last good result — the most recent refresh failed.
        </div>
      )}

      {/* Filters */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by lead name or number"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600"
          />
        </div>

        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={selectClass}>
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>

        <select
          value={temperature}
          onChange={(e) => setTemperature(e.target.value)}
          className={selectClass}
        >
          <option value="">All temperatures</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
        </select>

        {agents.length > 0 && (
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={selectClass}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {[a.firstName, a.lastName].filter(Boolean).join(' ') || a.email}
              </option>
            ))}
          </select>
        )}

        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={selectClass}
          aria-label="From date"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={selectClass}
          aria-label="To date"
        />

        {filtered && (
          <button
            onClick={clearFilters}
            className="text-xs text-slate-400 hover:text-slate-200 underline cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* List */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-xs">
            <span className="font-semibold text-slate-300">
              {calls.length} call{calls.length === 1 ? '' : 's'}
            </span>
            {calls.length === 200 && (
              <span className="text-2xs text-slate-500">showing the newest 200</span>
            )}
          </div>

          <div className="space-y-2.5 max-h-[580px] overflow-y-auto custom-scrollbar pr-1">
            {calls.length === 0 && (
              <div className="text-xs text-slate-500 py-8 text-center">
                {callsQuery.data === null
                  ? 'Loading…'
                  : filtered
                    ? 'No calls match these filters.'
                    : 'No calls yet. They appear here as soon as the AI places one.'}
              </div>
            )}

            {calls.map((call) => (
              <div
                key={call.id}
                onClick={() => setSelectedId(call.id)}
                className={`p-3.5 rounded-xl border transition-all cursor-pointer space-y-2 ${
                  call.id === selectedId
                    ? 'bg-slate-800/90 border-emerald-500/60 shadow-md'
                    : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        call.outcome === 'NO_ANSWER' || call.outcome === 'FAILED'
                          ? 'bg-slate-800 text-slate-500'
                          : 'bg-emerald-500/20 text-emerald-400'
                      }`}
                    >
                      {call.outcome === 'NO_ANSWER' || call.outcome === 'FAILED' ? (
                        <PhoneOff className="w-4 h-4" />
                      ) : (
                        <PhoneCall className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-xs text-white truncate">{call.leadName}</div>
                      <div className="text-2xs text-slate-400 font-mono truncate">
                        {call.leadPhone ?? 'no number'}
                      </div>
                    </div>
                  </div>

                  <span
                    className={`text-2xs font-bold font-mono px-2 py-0.5 rounded-full border shrink-0 ${OUTCOME_STYLES[call.outcome]}`}
                  >
                    {call.outcome.replace(/_/g, ' ')}
                  </span>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-800/60">
                  <span className="flex items-center gap-2">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-slate-500" />
                      {duration(call.durationSeconds)}
                    </span>
                    {call.recordingUrl && <Volume2 className="w-3 h-3 text-emerald-500" />}
                    {call.hasTranscript && <FileText className="w-3 h-3 text-cyan-500" />}
                    {call.temperature && (
                      <span
                        className={`text-2xs uppercase font-bold px-1.5 rounded border ${
                          TEMP_STYLES[call.temperature] ?? 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {call.temperature}
                      </span>
                    )}
                  </span>
                  <span title={new Date(call.createdAt).toLocaleString()}>
                    {new Date(call.startedAt ?? call.createdAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail */}
        {detail ? (
          <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white">{detail.leadName}</h3>
                  <span className="text-xs font-mono text-cyan-400">{detail.leadPhone}</span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  {detail.provider} • {detail.direction} •{' '}
                  {detail.startedAt ? new Date(detail.startedAt).toLocaleString() : 'not started'}
                  {detail.agentName && <> • owned by {detail.agentName}</>}
                </p>
              </div>
              <button
                onClick={() => setSelectedLeadId(detail.leadId)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors cursor-pointer shrink-0"
              >
                View Lead Dossier
              </button>
            </div>

            {/* Recording */}
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Volume2 className="w-4 h-4 text-emerald-400" />
                  Recording
                </span>
                <span className="font-mono text-slate-400">{duration(detail.durationSeconds)}</span>
              </div>
              {detail.recordingUrl ? (
                <audio controls preload="none" src={detail.recordingUrl} className="w-full">
                  Your browser cannot play this recording.
                </audio>
              ) : (
                <p className="text-xs text-slate-500">
                  No recording. Either the office has call recording switched off, or the file has
                  not finished uploading — Telnyx delivers it a little after the call ends.
                </p>
              )}
            </div>

            {/* Summary */}
            {detail.aiSummary && (
              <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-2">
                <div className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Summary
                </div>
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {detail.aiSummary}
                </p>
              </div>
            )}

            {/* Transcript */}
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Transcript
              </div>
              <div className="max-h-72 overflow-y-auto bg-slate-950 p-4 rounded-xl border border-slate-800 custom-scrollbar">
                {detail.transcript ? (
                  <pre className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap font-sans">
                    {detail.transcript}
                  </pre>
                ) : (
                  <p className="text-xs text-slate-500">
                    No transcript yet. Telnyx transcribes after the recording is closed, so it
                    arrives a minute or two behind the call.
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="lg:col-span-7 flex items-center justify-center p-12 text-xs text-slate-500">
            {selectedId ? 'Loading call…' : 'Select a call to inspect.'}
          </div>
        )}
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { 
  Phone, 
  PhoneCall, 
  Play, 
  Pause, 
  Volume2, 
  Sparkles, 
  Clock, 
  CheckCircle2, 
  ShieldCheck, 
  Building2, 
  PhoneForwarded, 
  RotateCw,
  Flame,
  FileText
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { CallRecord } from '../../types';

export const CallsView: React.FC = () => {
  const { calls, leads, startLiveCallSimulation, setSelectedLeadId } = useApp();
  const [selectedCallId, setSelectedCallId] = useState<string>(calls[0]?.id || '');
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  const activeCall = calls.find(c => c.id === selectedCallId) || calls[0];

  const toggleAudioSimulation = () => {
    setIsPlayingAudio(!isPlayingAudio);
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Retell AI Voice Call Studio</h2>
            <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/40">
              Provider: Retell
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Ultra-low latency real-estate voice conversations, automated qualification, and human transfer
          </p>
        </div>

        {leads[0] && (
          <button
            onClick={() => startLiveCallSimulation(leads[0])}
            className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white rounded-xl text-xs font-bold shadow-md shadow-emerald-950 flex items-center gap-2 transition-all cursor-pointer"
          >
            <PhoneForwarded className="w-4 h-4" />
            <span>Launch Live Call Simulation</span>
          </button>
        )}
      </div>

      {/* Main Grid: Call History on Left, Detailed Transcript & Player on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Call Logs List */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-xs">
            <span className="font-semibold text-slate-300">Recorded Calls ({calls.length})</span>
            <span className="text-[11px] text-emerald-400 font-mono">100% Retell Ingestion</span>
          </div>

          <div className="space-y-2.5 max-h-[580px] overflow-y-auto custom-scrollbar pr-1">
            {calls.map(call => {
              const isSelected = call.id === activeCall?.id;
              const mins = Math.floor(call.durationSeconds / 60);
              const secs = call.durationSeconds % 60;

              return (
                <div
                  key={call.id}
                  onClick={() => {
                    setSelectedCallId(call.id);
                    setIsPlayingAudio(false);
                  }}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer space-y-2 ${
                    isSelected 
                      ? 'bg-slate-800/90 border-emerald-500/60 shadow-md' 
                      : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                        <PhoneCall className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-bold text-xs text-white">{call.leadName}</div>
                        <div className="text-[10px] text-slate-400 font-mono">{call.leadPhone}</div>
                      </div>
                    </div>

                    <span className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded-full ${
                      call.outcome === 'APPOINTMENT_BOOKED'
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                        : call.outcome === 'QUALIFIED'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-slate-800 text-slate-400'
                    }`}>
                      {call.outcome}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800/60">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-slate-500" />
                      {mins}m {secs < 10 ? '0' : ''}{secs}s
                    </span>
                    <span>{new Date(call.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Selected Call Detail (Audio, Summary, Transcript, Extraction) */}
        {activeCall ? (
          <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
            
            {/* Call Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white">{activeCall.leadName}</h3>
                  <span className="text-xs font-mono text-cyan-400">{activeCall.leadPhone}</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Call ID: <code className="text-slate-300">{activeCall.providerCallId}</code> • Started: {new Date(activeCall.startedAt).toLocaleString()}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedLeadId(activeCall.leadId)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
                >
                  View Lead Dossier
                </button>
              </div>
            </div>

            {/* Simulated Audio Waveform Player */}
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Volume2 className="w-4 h-4 text-emerald-400" />
                  Call Recording & Audio Playback
                </span>
                <span className="font-mono text-slate-400">
                  {isPlayingAudio ? '0:42' : '0:00'} / {Math.floor(activeCall.durationSeconds / 60)}:{activeCall.durationSeconds % 60 < 10 ? '0' : ''}{activeCall.durationSeconds % 60}
                </span>
              </div>

              {/* Animated Waveform Bars */}
              <div className="flex items-center gap-1 h-12 px-2 bg-slate-900/80 rounded-lg overflow-hidden">
                {Array.from({ length: 36 }).map((_, i) => {
                  const height = isPlayingAudio 
                    ? `${Math.sin(i * 0.4) * 50 + 40}%` 
                    : `${((i * 13) % 40) + 20}%`;
                  return (
                    <div
                      key={i}
                      className={`flex-1 rounded-full transition-all duration-300 ${
                        isPlayingAudio && i < 16 ? 'bg-emerald-500' : 'bg-slate-700'
                      }`}
                      style={{ height }}
                    />
                  );
                })}
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={toggleAudioSimulation}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  {isPlayingAudio ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                  <span>{isPlayingAudio ? 'Pause Recording' : 'Play Call Audio'}</span>
                </button>
                <span className="text-[11px] text-slate-500 font-mono">Stereo • 16kHz Webhook Stream</span>
              </div>
            </div>

            {/* AI Summary Box (PRD Section 40) */}
            <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-2">
              <div className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                AI Call Summary & Extracted Intelligence
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {activeCall.summary}
              </p>
            </div>

            {/* Full Transcript (PRD Section 40) */}
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Full Dialogue Transcript ({activeCall.transcript.length} turns)
              </div>
              <div className="max-h-60 overflow-y-auto space-y-2 bg-slate-950 p-4 rounded-xl border border-slate-800 custom-scrollbar">
                {activeCall.transcript.map((turn, idx) => (
                  <div key={idx} className="text-xs flex items-start gap-3">
                    <span className="font-mono text-[10px] text-slate-500 w-10 shrink-0 pt-0.5">
                      {turn.timestamp}
                    </span>
                    <span className={`font-semibold shrink-0 w-20 text-[11px] ${
                      turn.speaker.includes('AI') ? 'text-emerald-400' : 'text-slate-300'
                    }`}>
                      {turn.speaker}:
                    </span>
                    <span className="text-slate-200 leading-relaxed flex-1">
                      {turn.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        ) : (
          <div className="lg:col-span-7 flex items-center justify-center p-12 text-xs text-slate-500">
            Select a call record to inspect.
          </div>
        )}

      </div>

    </div>
  );
};

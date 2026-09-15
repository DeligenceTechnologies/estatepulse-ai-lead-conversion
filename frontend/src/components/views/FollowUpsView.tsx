import React from 'react';
import { 
  GitFork, 
  Clock, 
  MessageSquare, 
  PhoneCall, 
  ShieldAlert, 
  CheckCircle2, 
  Play, 
  Pause, 
  ArrowDown,
  Sparkles,
  Sliders
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const FollowUpsView: React.FC = () => {
  const { followupSequences, orgSettings } = useApp();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Automated Follow-Up Sequences</h2>
          <p className="text-xs text-slate-400">
            Multi-step n8n workflow triggers (WF-12, WF-13, WF-14) with autonomous pause upon appointment booking
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-slate-300">
          <ShieldAlert className="w-4 h-4 text-rose-400" />
          <span>STOP / DNC Suppression: <strong className="text-emerald-400">Enforced 100%</strong></span>
        </div>
      </div>

      {/* Compliance Notice Banner (PRD Section 52) */}
      <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl text-xs text-slate-300 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <div className="font-bold text-slate-100">TCPA & 10DLC Telephony Compliance Rules (PRD Section 34 & 52)</div>
          <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
            All sequences automatically cease immediately if a lead responds with STOP/UNSUBSCRIBE, if an appointment is booked, if the contact is placed on DNC, or outside the configured business hours ({orgSettings.businessHours.start} – {orgSettings.businessHours.end} {orgSettings.timezone}).
          </p>
        </div>
      </div>

      {/* Sequences Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {followupSequences.map(seq => (
          <div 
            key={seq.id}
            className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                  {seq.trigger}
                </span>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                  seq.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                }`}>
                  {seq.status}
                </span>
              </div>

              <div>
                <h3 className="text-sm font-bold text-white">{seq.name}</h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">{seq.description}</p>
              </div>

              {/* Steps Timeline Visualizer */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Sequential Execution Steps:
                </div>

                <div className="space-y-2">
                  {seq.steps.map((step, idx) => (
                    <div key={idx} className="flex items-start gap-2.5 text-xs bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/60">
                      <div className="w-5 h-5 rounded-full bg-slate-800 text-[10px] font-bold font-mono text-emerald-400 flex items-center justify-center shrink-0">
                        {step.step}
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                          <Clock className="w-3 h-3 text-amber-400" />
                          <span>Delay: {step.delay}</span>
                          <span className="text-slate-500">•</span>
                          <span className="capitalize text-cyan-400">{step.channel}</span>
                        </div>
                        <p className="text-[11px] text-slate-400">{step.actionDescription}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-400">Enrolled Leads:</span>
              <span className="font-mono font-bold text-white">{seq.enrolledLeadsCount} prospects</span>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
};

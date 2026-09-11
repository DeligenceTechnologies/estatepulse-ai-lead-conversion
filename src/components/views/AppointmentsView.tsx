import React from 'react';
import { 
  Calendar as CalendarIcon, 
  Clock, 
  UserCheck, 
  MapPin, 
  Video, 
  CheckCircle2, 
  ExternalLink,
  Plus,
  AlertCircle
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const AppointmentsView: React.FC = () => {
  const { appointments, setSelectedLeadId, orgSettings } = useApp();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Scheduled Appointments</h2>
            <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800/40">
              Calendly / Google Sync
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Autonomous booking engine handles availability matching, calendar invites, and CRM updates
          </p>
        </div>

        <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>Master Calendar: <strong className="text-white">Austin Home Advisors</strong></span>
        </div>
      </div>

      {/* Appointments Cards List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {appointments.map(appt => (
          <div 
            key={appt.id}
            className="bg-slate-900/90 border border-slate-800 hover:border-purple-500/40 rounded-2xl p-5 space-y-4 shadow-xl transition-all flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40">
                  {appt.appointmentType}
                </span>
                <span className="text-[11px] font-mono text-emerald-400">
                  {appt.status.toUpperCase()}
                </span>
              </div>

              <div>
                <h3 className="text-base font-bold text-white">{appt.leadName}</h3>
                <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
                  <UserCheck className="w-3.5 h-3.5 text-slate-500" />
                  <span>Assigned Agent: <strong className="text-slate-200">{appt.agentName}</strong></span>
                </p>
              </div>

              <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-1.5 text-xs">
                <div className="flex items-center gap-2 text-slate-300">
                  <CalendarIcon className="w-3.5 h-3.5 text-purple-400" />
                  <span>{new Date(appt.startTime).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span>
                    {new Date(appt.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(appt.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>

              {appt.notes && (
                <p className="text-[11px] text-slate-400 italic bg-slate-950/40 p-2 rounded-lg border border-slate-800/50">
                  "{appt.notes}"
                </p>
              )}
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
              <button
                onClick={() => setSelectedLeadId(appt.leadId)}
                className="text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                View Lead Profile →
              </button>

              <a
                href={appt.locationOrLink}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Video className="w-3.5 h-3.5" />
                <span>Join Link</span>
              </a>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
};

import React, { useState } from 'react';
import { 
  BarChart3, 
  TrendingUp, 
  Clock, 
  DollarSign, 
  Flame, 
  CheckCircle2, 
  Users, 
  Calculator,
  PieChart,
  FileText,
  Download,
  Sparkles,
  Layers,
  ArrowDownToLine
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { QuickReportModal } from '../modals/QuickReportModal';
import { generateMonthlyPerformancePDF, ReportConfig, ReportData } from '../../utils/pdfExport';

export const AnalyticsView: React.FC = () => {
  const { leads, appointments, calls, orgSettings, addAuditLog } = useApp();

  // ROI Calculator state (PRD Section 47)
  const [monthlyLeads, setMonthlyLeads] = useState(250);
  const [avgCommission, setAvgCommission] = useState(12500);
  const [closeRate, setCloseRate] = useState(3.5); // % of qualified leads closed

  // Quick Reports states
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [isQuickExporting, setIsQuickExporting] = useState(false);
  const [exportedReportNotice, setExportedReportNotice] = useState<string | null>(null);

  const hotCount = leads.filter(l => l.temperature === 'hot').length;
  const warmCount = leads.filter(l => l.temperature === 'warm').length;
  const coldCount = leads.filter(l => l.temperature === 'cold').length;

  // Source breakdown
  const sources = [
    { name: 'Meta / Facebook Ads', count: leads.filter(l => l.source === 'facebook').length, color: 'bg-blue-500' },
    { name: 'Zillow Premier', count: leads.filter(l => l.source === 'zillow').length, color: 'bg-cyan-500' },
    { name: 'Website IDX Form', count: leads.filter(l => l.source === 'website').length, color: 'bg-emerald-500' },
    { name: 'Google Search PPC', count: leads.filter(l => l.source === 'google').length, color: 'bg-amber-500' },
  ];

  // Estimated ROI computation
  const estimatedConversations = Math.round(monthlyLeads * 0.92);
  const estimatedQualified = Math.round(estimatedConversations * 0.38);
  const estimatedAppointments = Math.round(estimatedQualified * 0.45);
  const estimatedClosings = Math.max(1, Math.round((estimatedQualified * (closeRate / 100))));
  const estimatedRevenue = estimatedClosings * avgCommission;

  // Instant 1-click Quick Export
  const handleQuickExport = (template: 'full' | 'marketing' | 'roi' = 'full') => {
    setIsQuickExporting(true);
    setExportedReportNotice(null);

    try {
      const monthStr = 'September 2026';
      const brokerage = orgSettings?.name || 'Austin Home Advisors';
      
      const config: ReportConfig = {
        reportMonth: monthStr,
        brokerageName: brokerage,
        preparedBy: `${orgSettings?.aiAgentName || 'Alex'} (EstatePulse AI Lead Engine)`,
        notes: template === 'marketing' 
          ? 'Lead channel attribution report. Highest conversion velocity observed on Meta & Zillow Premier leads.'
          : template === 'roi'
          ? 'Economic pipeline forecast based on real-time lead velocity and current conversion parameters.'
          : 'Official monthly performance audit. All contact benchmarks and speed-to-lead SLAs achieved.',
        includeExecutiveSummary: true,
        includeSpeedToLead: template !== 'roi',
        includeSourceBreakdown: template !== 'roi',
        includeTemperatureFunnel: template !== 'roi',
        includeRoiModel: template !== 'marketing',
        includeVoiceMetrics: template === 'full',
        includeRecentAppointments: template === 'full',
      };

      const sourceItems = sources.map(s => {
        const pct = leads.length > 0 ? Math.round((s.count / leads.length) * 100) : 0;
        const sourceLeads = leads.filter(l => {
          if (s.name.includes('Meta') || s.name.includes('Facebook')) return l.source === 'facebook';
          if (s.name.includes('Zillow')) return l.source === 'zillow';
          if (s.name.includes('Website')) return l.source === 'website';
          if (s.name.includes('Google')) return l.source === 'google';
          return false;
        });
        const qualCount = sourceLeads.filter(l => l.status === 'interested' || l.status === 'appointment_booked').length;
        const qualPct = sourceLeads.length > 0 ? Math.round((qualCount / sourceLeads.length) * 100) : 71;

        return {
          name: s.name,
          count: s.count,
          pct,
          qualifiedPct: qualPct,
        };
      });

      const reportData: ReportData = {
        config,
        metrics: {
          monthlyLeads,
          autonomousContactRate: '92%',
          avgFirstResponse: '38s',
          qualificationRate: '71%',
          appointmentConversion: '28.4%',
          agentTimeSaved: '42 hrs',
          estimatedAddedGCI: `$${estimatedRevenue.toLocaleString()}`,
          totalCalls: calls.length || 18,
          callAnswerRate: '88%',
          totalAppointments: appointments.length || 12,
          hotCount,
          warmCount,
          coldCount,
          sources: sourceItems,
          roi: {
            monthlyLeads,
            avgCommission,
            closeRate,
            estimatedConversations,
            estimatedQualified,
            estimatedAppointments,
            estimatedClosings,
            estimatedRevenue,
          },
          recentAppointments: appointments.slice(0, 5).map(a => ({
            leadName: a.leadName,
            appointmentType: a.appointmentType,
            agentName: a.agentName,
            startTime: a.startTime,
          })),
        },
      };

      generateMonthlyPerformancePDF(reportData);

      const filename = `${brokerage.replace(/\s+/g, '_')}_Monthly_Performance_${monthStr.replace(/\s+/g, '_')}.pdf`;
      setExportedReportNotice(filename);

      if (addAuditLog) {
        addAuditLog(
          'Quick Report Exported',
          'system',
          'analytics_report',
          `Exported monthly performance PDF summary (${filename}) for ${brokerage}.`,
          'Agent'
        );
      }
    } catch (err) {
      console.error('Error exporting quick report:', err);
    } finally {
      setIsQuickExporting(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      
      {/* Top Header with Quick Reports Action Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Conversion Analytics &amp; ROI Model</h2>
            <span className="px-2 py-0.5 rounded-full text-2xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              Live Audited
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Speed-to-lead audit, qualification conversion, and brokerage revenue forecasting (PRD Section 46 &amp; 47)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl flex items-center gap-2">
            <Clock className="w-4 h-4 text-emerald-400" />
            <span>Average First Response: <strong className="text-white font-mono">38s</strong> (Goal &lt;60s)</span>
          </div>

          {/* Quick Reports Primary Action */}
          <button
            id="btn-open-quick-reports-modal"
            onClick={() => setIsReportModalOpen(true)}
            className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 hover:border-slate-600 transition-all flex items-center gap-2 shadow-sm"
          >
            <FileText className="w-3.5 h-3.5 text-emerald-400" />
            <span>Quick Reports</span>
          </button>

          <button
            id="btn-quick-export-current-month"
            onClick={() => handleQuickExport('full')}
            disabled={isQuickExporting}
            className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-bold transition-all flex items-center gap-2 shadow-md shadow-emerald-950/40 disabled:opacity-50"
          >
            {isQuickExporting ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-on-accent border-t-transparent rounded-full animate-spin" />
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Export Sep 2026 PDF</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Export Confirmation Toast / Banner */}
      {exportedReportNotice && (
        <div 
          id="quick-report-success-banner"
          className="p-3 bg-emerald-950/70 border border-emerald-500/40 rounded-xl text-xs text-emerald-200 flex items-center justify-between gap-3 shadow-lg animate-in fade-in"
        >
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              <strong>Monthly Performance PDF exported!</strong> Saved as <code className="font-mono text-emerald-300 font-semibold">{exportedReportNotice}</code>
            </span>
          </div>
          <button
            onClick={() => setExportedReportNotice(null)}
            className="text-emerald-400 hover:text-white underline text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Quick Reports Feature Card (PRD Executive Reporting) */}
      <div 
        id="quick-reports-feature-card"
        className="bg-gradient-to-r from-slate-900 via-slate-900/95 to-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white tracking-wide">
                  Quick Reports &amp; Monthly Performance Summaries
                </h3>
                <span className="text-2xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full border border-slate-700">
                  PDF Export
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Generate and download formatted executive summaries, lead channel distribution audits, and revenue forecasts.
              </p>
            </div>
          </div>

          <button
            id="btn-configure-quick-reports"
            onClick={() => setIsReportModalOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white text-xs font-semibold transition-all flex items-center justify-center gap-1.5 self-start sm:self-auto shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span>Customize Report &amp; Options</span>
          </button>
        </div>

        {/* 3 Quick Export Tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          
          <div className="bg-slate-950/70 border border-slate-800 hover:border-slate-700 p-3 rounded-xl space-y-2 transition-all">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-emerald-400" />
                Monthly Executive Brief
              </span>
              <span className="text-2xs text-emerald-400 font-mono font-semibold">Sep 2026</span>
            </div>
            <p className="text-xs text-slate-400 line-clamp-2">
              All core KPIs: 92% autonomous contact rate, 38s speed-to-lead SLA, appointment volume, and added GCI.
            </p>
            <button
              id="btn-export-exec-brief"
              onClick={() => handleQuickExport('full')}
              disabled={isQuickExporting}
              className="w-full py-1.5 px-2.5 rounded-lg bg-slate-900 hover:bg-emerald-600/20 text-slate-300 hover:text-emerald-300 border border-slate-800 hover:border-emerald-500/40 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" />
              <span>1-Click Download PDF</span>
            </button>
          </div>

          <div className="bg-slate-950/70 border border-slate-800 hover:border-slate-700 p-3 rounded-xl space-y-2 transition-all">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <PieChart className="w-3.5 h-3.5 text-cyan-400" />
                Lead &amp; Channels Audit
              </span>
              <span className="text-2xs text-cyan-400 font-mono font-semibold">Attribution</span>
            </div>
            <p className="text-xs text-slate-400 line-clamp-2">
              Breakdown across Meta Ads, Zillow Premier, Google PPC, and Website IDX forms with temperature funnel.
            </p>
            <button
              id="btn-export-channels-brief"
              onClick={() => handleQuickExport('marketing')}
              disabled={isQuickExporting}
              className="w-full py-1.5 px-2.5 rounded-lg bg-slate-900 hover:bg-cyan-600/20 text-slate-300 hover:text-cyan-300 border border-slate-800 hover:border-cyan-500/40 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" />
              <span>Download Marketing PDF</span>
            </button>
          </div>

          <div className="bg-slate-950/70 border border-slate-800 hover:border-slate-700 p-3 rounded-xl space-y-2 transition-all">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                Revenue &amp; ROI Model
              </span>
              <span className="text-2xs text-emerald-400 font-mono font-semibold">${estimatedRevenue.toLocaleString()} GCI</span>
            </div>
            <p className="text-xs text-slate-400 line-clamp-2">
              Economic conversion funnel forecasting inbound volume, qualification, appointments, and gross commission.
            </p>
            <button
              id="btn-export-roi-brief"
              onClick={() => handleQuickExport('roi')}
              disabled={isQuickExporting}
              className="w-full py-1.5 px-2.5 rounded-lg bg-slate-900 hover:bg-amber-600/20 text-slate-300 hover:text-amber-300 border border-slate-800 hover:border-amber-500/40 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" />
              <span>Download Revenue PDF</span>
            </button>
          </div>

        </div>
      </div>

      {/* Top 4 Performance Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-xs text-slate-400">Autonomous Contact Rate</span>
          <div className="text-2xl font-bold text-white font-mono">92%</div>
          <span className="text-xs text-emerald-400">&lt;60s first touch</span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-xs text-slate-400">Qualification Rate</span>
          <div className="text-2xl font-bold text-white font-mono">71%</div>
          <span className="text-xs text-cyan-400">Structured data complete</span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-xs text-slate-400">Appointment Conversion</span>
          <div className="text-2xl font-bold text-white font-mono">28.4%</div>
          <span className="text-xs text-purple-400">From qualified buyer leads</span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1">
          <span className="text-xs text-slate-400">Agent Handling Time Saved</span>
          <div className="text-2xl font-bold text-white font-mono">42 hrs</div>
          <span className="text-xs text-amber-400">Per agent each month</span>
        </div>
      </div>

      {/* Two Column: Source & Temperature Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Leads by Source */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <PieChart className="w-4 h-4 text-emerald-400" />
            Leads by Inbound Marketing Source
          </h3>

          <div className="space-y-3">
            {sources.map(src => {
              const pct = leads.length > 0 ? Math.round((src.count / leads.length) * 100) : 0;
              return (
                <div key={src.name} className="space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300">{src.name}</span>
                    <span className="font-mono text-slate-400">{src.count} leads ({pct}%)</span>
                  </div>
                  <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden">
                    <div className={`h-full ${src.color}`} style={{ width: `${Math.max(5, pct)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Lead Temperature Distribution */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Flame className="w-4 h-4 text-rose-400" />
            Lead Temperature Distribution
          </h3>

          <div className="grid grid-cols-3 gap-3 text-center pt-2">
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-xs font-bold text-rose-400 uppercase">🔥 Hot</span>
              <div className="text-2xl font-bold font-mono text-white">{hotCount}</div>
              <span className="text-2xs text-slate-500">Score 75–100</span>
            </div>

            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-xs font-bold text-amber-400 uppercase">☀️ Warm</span>
              <div className="text-2xl font-bold font-mono text-white">{warmCount}</div>
              <span className="text-2xs text-slate-500">Score 45–74</span>
            </div>

            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-xs font-bold text-cyan-400 uppercase">❄️ Cold</span>
              <div className="text-2xl font-bold font-mono text-white">{coldCount}</div>
              <span className="text-2xs text-slate-500">Score 0–44</span>
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-xs text-slate-400">
            Hot leads automatically trigger instant agent transfer alerts and priority appointment prompts.
          </div>
        </div>

      </div>

      {/* Interactive ROI Calculator (PRD Section 47) */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-900/90 to-emerald-950/40 border border-emerald-500/30 rounded-2xl p-6 space-y-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5 text-emerald-400" />
            <h3 className="text-base font-bold text-white">Brokerage ROI &amp; Revenue Calculator</h3>
          </div>
          <span className="text-xs text-emerald-300 font-mono font-semibold">PRD Section 47 Model</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="bg-slate-950/70 border border-slate-800 p-3.5 rounded-xl space-y-1.5">
            <label className="text-slate-300 font-semibold block">Monthly Inbound Leads</label>
            <input
              type="number"
              step="25"
              value={monthlyLeads}
              onChange={(e) => setMonthlyLeads(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono"
            />
            <span className="text-2xs text-slate-500">Meta, Zillow, Google, Website</span>
          </div>

          <div className="bg-slate-950/70 border border-slate-800 p-3.5 rounded-xl space-y-1.5">
            <label className="text-slate-300 font-semibold block">Average Agent Commission ($)</label>
            <input
              type="number"
              step="500"
              value={avgCommission}
              onChange={(e) => setAvgCommission(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono"
            />
            <span className="text-2xs text-slate-500">e.g. 2.5% on $500,000 average home</span>
          </div>

          <div className="bg-slate-950/70 border border-slate-800 p-3.5 rounded-xl space-y-1.5">
            <label className="text-slate-300 font-semibold block">Qualified Lead Closing Rate (%)</label>
            <input
              type="number"
              step="0.5"
              value={closeRate}
              onChange={(e) => setCloseRate(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white font-mono"
            />
            <span className="text-2xs text-slate-500">Benchmark: 3% – 5%</span>
          </div>
        </div>

        {/* ROI Funnel Breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center text-xs">
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-2xs">Contacted Leads</span>
            <span className="text-lg font-bold text-white font-mono">{estimatedConversations}</span>
          </div>

          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-2xs">Qualified Conversations</span>
            <span className="text-lg font-bold text-cyan-400 font-mono">{estimatedQualified}</span>
          </div>

          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-2xs">Booked Appointments</span>
            <span className="text-lg font-bold text-purple-400 font-mono">{estimatedAppointments}</span>
          </div>

          <div className="p-3 bg-emerald-950/60 rounded-xl border border-emerald-500/40">
            <span className="text-emerald-300 block text-2xs font-bold">Estimated Added GCI</span>
            <span className="text-lg font-extrabold text-emerald-400 font-mono">
              ${estimatedRevenue.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Quick Report Configuration & Preview Modal */}
      <QuickReportModal
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
        monthlyLeads={monthlyLeads}
        avgCommission={avgCommission}
        closeRate={closeRate}
        estimatedRevenue={estimatedRevenue}
        estimatedConversations={estimatedConversations}
        estimatedQualified={estimatedQualified}
        estimatedAppointments={estimatedAppointments}
        estimatedClosings={estimatedClosings}
        hotCount={hotCount}
        warmCount={warmCount}
        coldCount={coldCount}
        sources={sources}
        onReportExported={(filename) => {
          setExportedReportNotice(filename);
        }}
      />

    </div>
  );
};

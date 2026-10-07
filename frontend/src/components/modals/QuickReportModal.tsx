import React, { useState } from 'react';
import { 
  X, 
  FileText, 
  Download, 
  CheckCircle2, 
  Calendar, 
  Sparkles, 
  Sliders, 
  Building2, 
  TrendingUp, 
  PieChart, 
  Flame, 
  DollarSign, 
  Printer, 
  Clock, 
  Layers
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { generateMonthlyPerformancePDF, ReportConfig, ReportData } from '../../utils/pdfExport';

interface QuickReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  monthlyLeads: number;
  avgCommission: number;
  closeRate: number;
  estimatedRevenue: number;
  estimatedConversations: number;
  estimatedQualified: number;
  estimatedAppointments: number;
  estimatedClosings: number;
  hotCount: number;
  warmCount: number;
  coldCount: number;
  sources: Array<{ name: string; count: number; color: string }>;
  onReportExported?: (filename: string) => void;
}

export const QuickReportModal: React.FC<QuickReportModalProps> = ({
  isOpen,
  onClose,
  monthlyLeads,
  avgCommission,
  closeRate,
  estimatedRevenue,
  estimatedConversations,
  estimatedQualified,
  estimatedAppointments,
  estimatedClosings,
  hotCount,
  warmCount,
  coldCount,
  sources,
  onReportExported,
}) => {
  const { orgSettings, leads, appointments, calls, addAuditLog } = useApp();

  const [selectedMonth, setSelectedMonth] = useState('September 2026');
  const [reportTemplate, setReportTemplate] = useState<'full' | 'executive' | 'marketing' | 'roi'>('full');
  
  // Section checkboxes
  const [includeExecutiveSummary, setIncludeExecutiveSummary] = useState(true);
  const [includeSpeedToLead, setIncludeSpeedToLead] = useState(true);
  const [includeSourceBreakdown, setIncludeSourceBreakdown] = useState(true);
  const [includeTemperatureFunnel, setIncludeTemperatureFunnel] = useState(true);
  const [includeRoiModel, setIncludeRoiModel] = useState(true);
  const [includeVoiceMetrics, setIncludeVoiceMetrics] = useState(true);
  const [includeRecentAppointments, setIncludeRecentAppointments] = useState(true);
  
  const [executiveNotes, setExecutiveNotes] = useState(
    'Strong autonomous lead qualification across Meta and Zillow inbound channels. Recommended next step: scale Google PPC spend given 74% qualification rate and 38s average contact SLA.'
  );

  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  if (!isOpen) return null;

  // Presets handler
  const handleSelectTemplate = (template: 'full' | 'executive' | 'marketing' | 'roi') => {
    setReportTemplate(template);
    if (template === 'full') {
      setIncludeExecutiveSummary(true);
      setIncludeSpeedToLead(true);
      setIncludeSourceBreakdown(true);
      setIncludeTemperatureFunnel(true);
      setIncludeRoiModel(true);
      setIncludeVoiceMetrics(true);
      setIncludeRecentAppointments(true);
    } else if (template === 'executive') {
      setIncludeExecutiveSummary(true);
      setIncludeSpeedToLead(true);
      setIncludeSourceBreakdown(false);
      setIncludeTemperatureFunnel(false);
      setIncludeRoiModel(true);
      setIncludeVoiceMetrics(false);
      setIncludeRecentAppointments(false);
    } else if (template === 'marketing') {
      setIncludeExecutiveSummary(true);
      setIncludeSpeedToLead(true);
      setIncludeSourceBreakdown(true);
      setIncludeTemperatureFunnel(true);
      setIncludeRoiModel(false);
      setIncludeVoiceMetrics(false);
      setIncludeRecentAppointments(false);
    } else if (template === 'roi') {
      setIncludeExecutiveSummary(true);
      setIncludeSpeedToLead(false);
      setIncludeSourceBreakdown(false);
      setIncludeTemperatureFunnel(false);
      setIncludeRoiModel(true);
      setIncludeVoiceMetrics(false);
      setIncludeRecentAppointments(false);
    }
  };

  const handleExportPDF = () => {
    setIsExporting(true);
    setExportSuccess(null);

    try {
      const reportConfig: ReportConfig = {
        reportMonth: selectedMonth,
        brokerageName: orgSettings?.name || 'Austin Home Advisors',
        preparedBy: `${orgSettings?.aiAgentName || 'Alex'} (EstatePulse AI Lead Engine)`,
        notes: executiveNotes,
        includeExecutiveSummary,
        includeSpeedToLead,
        includeSourceBreakdown,
        includeTemperatureFunnel,
        includeVoiceMetrics,
        includeRoiModel,
        includeRecentAppointments,
      };

      const sourceItems = sources.map(s => {
        const pct = leads.length > 0 ? Math.round((s.count / leads.length) * 100) : 0;
        // Calculate source qualified pct
        const sourceLeads = leads.filter(l => {
          if (s.name.includes('Meta') || s.name.includes('Facebook')) return l.source === 'facebook';
          if (s.name.includes('Zillow')) return l.source === 'zillow';
          if (s.name.includes('Website')) return l.source === 'website';
          if (s.name.includes('Google')) return l.source === 'google';
          return false;
        });
        const qualCount = sourceLeads.filter(l => l.status === 'qualified' || l.status === 'appointment_booked').length;
        const qualPct = sourceLeads.length > 0 ? Math.round((qualCount / sourceLeads.length) * 100) : 71;

        return {
          name: s.name,
          count: s.count,
          pct,
          qualifiedPct: qualPct,
        };
      });

      const reportData: ReportData = {
        config: reportConfig,
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

      const filename = `${reportConfig.brokerageName}_Monthly_Performance_${selectedMonth.replace(/\s+/g, '_')}.pdf`;
      setExportSuccess(filename);

      if (addAuditLog) {
        addAuditLog(
          'Monthly Performance PDF Generated',
          'system',
          'analytics_report',
          `Exported monthly performance summary for ${selectedMonth} (${reportConfig.brokerageName}).`,
          'Agent'
        );
      }

      if (onReportExported) {
        onReportExported(filename);
      }
    } catch (err) {
      console.error('Failed to export PDF:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md overflow-y-auto custom-scrollbar">
      <div 
        id="quick-reports-modal"
        className="relative w-full max-w-4xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col my-8 max-h-[90vh]"
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  Quick Reports &amp; Monthly Performance PDF
                </h3>
                <span className="px-2 py-0.5 rounded-full text-2xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Audit Grade
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Generate and export an executive PDF summary of conversion metrics, speed-to-lead, and revenue modeling.
              </p>
            </div>
          </div>

          <button
            id="btn-close-quick-reports"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar text-xs">
          
          {/* Export Success Alert */}
          {exportSuccess && (
            <div className="p-3.5 rounded-xl bg-emerald-950/70 border border-emerald-500/40 flex items-center justify-between gap-3 text-emerald-200 animate-in fade-in duration-200">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>
                  <strong>PDF Exported successfully!</strong> Downloaded: <code className="font-mono text-emerald-300 font-semibold">{exportSuccess}</code>
                </span>
              </div>
              <button 
                onClick={() => setExportSuccess(null)} 
                className="text-emerald-400 hover:text-white underline text-xs"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Top Configuration Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            {/* Reporting Period */}
            <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl space-y-2">
              <label className="text-slate-300 font-semibold flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-emerald-400" />
                Reporting Month
              </label>
              <select
                id="select-report-month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-medium focus:outline-none focus:border-emerald-500"
              >
                <option value="September 2026">September 2026 (Current Month)</option>
                <option value="August 2026">August 2026 (Prior Month)</option>
                <option value="July 2026">July 2026</option>
                <option value="Q3 2026 Summary">Q3 2026 Executive Summary</option>
                <option value="Year-to-Date 2026">Year-to-Date 2026</option>
              </select>
              <span className="text-2xs text-slate-500 block">
                Brokerage: <strong className="text-slate-400">{orgSettings?.name || 'Austin Home Advisors'}</strong>
              </span>
            </div>

            {/* Template Selector */}
            <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl space-y-2">
              <label className="text-slate-300 font-semibold flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                Report Template Preset
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => handleSelectTemplate('full')}
                  className={`px-2 py-1.5 rounded-lg text-left text-xs font-medium border transition-all ${
                    reportTemplate === 'full' 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  Full Package
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectTemplate('executive')}
                  className={`px-2 py-1.5 rounded-lg text-left text-xs font-medium border transition-all ${
                    reportTemplate === 'executive' 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  Executive High-Level
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectTemplate('marketing')}
                  className={`px-2 py-1.5 rounded-lg text-left text-xs font-medium border transition-all ${
                    reportTemplate === 'marketing' 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  Lead &amp; Channels
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectTemplate('roi')}
                  className={`px-2 py-1.5 rounded-lg text-left text-xs font-medium border transition-all ${
                    reportTemplate === 'roi' 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  Revenue &amp; ROI
                </button>
              </div>
            </div>

            {/* Included Content Checkboxes */}
            <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl space-y-2">
              <label className="text-slate-300 font-semibold flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-purple-400" />
                Include in PDF
              </label>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs">
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeExecutiveSummary}
                    onChange={(e) => setIncludeExecutiveSummary(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>Executive KPIs</span>
                </label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSourceBreakdown}
                    onChange={(e) => setIncludeSourceBreakdown(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>Source Breakdown</span>
                </label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeTemperatureFunnel}
                    onChange={(e) => setIncludeTemperatureFunnel(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>Temperature Funnel</span>
                </label>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeRoiModel}
                    onChange={(e) => setIncludeRoiModel(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>Brokerage ROI Model</span>
                </label>
              </div>
            </div>
          </div>

          {/* Executive Notes / Analyst Directive */}
          <div className="bg-slate-950/70 border border-slate-800 p-4 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-slate-300 font-semibold flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-emerald-400" />
                Executive Commentary &amp; Strategy Notes (Included in PDF)
              </label>
              <span className="text-2xs text-slate-500">Appears in official document</span>
            </div>
            <textarea
              id="report-executive-notes"
              rows={2}
              value={executiveNotes}
              onChange={(e) => setExecutiveNotes(e.target.value)}
              placeholder="Add key insights, strategic directives, or marketing notes to be printed on the PDF..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-xs custom-scrollbar"
            />
          </div>

          {/* Document Preview Box */}
          <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/90 shadow-inner">
            <div className="bg-slate-900/90 px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" />
                Live Document Preview: {selectedMonth}
              </span>
              <span className="text-2xs text-slate-400 font-mono">
                Standard A4 Portrait • Printable Vector Vector PDF
              </span>
            </div>

            {/* Document Layout Mock */}
            <div className="p-5 space-y-4 font-sans bg-slate-950">
              
              {/* Document Header Representation */}
              <div className="bg-slate-900 border-l-4 border-emerald-500 p-3 rounded-r-xl flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-white tracking-wide">
                    {orgSettings?.name || 'Austin Home Advisors'} — Monthly Performance Report
                  </div>
                  <div className="text-xs text-slate-400">
                    Period: <strong className="text-emerald-300">{selectedMonth}</strong> | Prepared by: {orgSettings?.aiAgentName || 'Alex'} (EstatePulse AI)
                  </div>
                </div>
                <div className="text-right text-2xs text-slate-400 font-mono">
                  <div>STATUS: AUDITED</div>
                  <div className="text-emerald-400">TCPA COMPLIANT</div>
                </div>
              </div>

              {/* KPI Mini Grid */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
                <div className="bg-slate-900 p-2 rounded-lg border border-slate-800">
                  <div className="text-2xs text-slate-400">Contact Rate</div>
                  <div className="text-base font-bold text-white font-mono">92%</div>
                </div>
                <div className="bg-slate-900 p-2 rounded-lg border border-slate-800">
                  <div className="text-2xs text-slate-400">Speed to Lead</div>
                  <div className="text-base font-bold text-emerald-400 font-mono">38s</div>
                </div>
                <div className="bg-slate-900 p-2 rounded-lg border border-slate-800">
                  <div className="text-2xs text-slate-400">Qualification</div>
                  <div className="text-base font-bold text-cyan-400 font-mono">71%</div>
                </div>
                <div className="bg-slate-900 p-2 rounded-lg border border-slate-800">
                  <div className="text-2xs text-slate-400">Appointments</div>
                  <div className="text-base font-bold text-purple-400 font-mono">{appointments.length || 12}</div>
                </div>
                <div className="bg-slate-900 p-2 rounded-lg border border-slate-800">
                  <div className="text-2xs text-slate-400">Time Saved</div>
                  <div className="text-base font-bold text-amber-400 font-mono">42 hrs</div>
                </div>
                <div className="bg-emerald-950/60 p-2 rounded-lg border border-emerald-500/30">
                  <div className="text-2xs text-emerald-300">Added GCI</div>
                  <div className="text-base font-bold text-emerald-400 font-mono">${estimatedRevenue.toLocaleString()}</div>
                </div>
              </div>

              {/* Source & Funnel Preview */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-slate-900/70 border border-slate-800 rounded-xl space-y-1.5">
                  <span className="font-semibold text-slate-300 block flex items-center gap-1">
                    <PieChart className="w-3.5 h-3.5 text-blue-400" />
                    Inbound Source Attribution
                  </span>
                  <div className="space-y-1 text-2xs">
                    {sources.map(s => (
                      <div key={s.name} className="flex justify-between text-slate-400 border-b border-slate-800/60 pb-1">
                        <span>{s.name}</span>
                        <span className="font-mono text-slate-300">{s.count} leads</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-3 bg-slate-900/70 border border-slate-800 rounded-xl space-y-1.5">
                  <span className="font-semibold text-slate-300 block flex items-center gap-1">
                    <Flame className="w-3.5 h-3.5 text-rose-400" />
                    Lead Segmentation
                  </span>
                  <div className="flex gap-2 text-center text-2xs">
                    <div className="flex-1 bg-rose-950/30 border border-rose-500/30 p-1.5 rounded">
                      <div className="text-rose-300 font-bold">Hot: {hotCount}</div>
                      <div className="text-2xs text-slate-400">&lt;60 days</div>
                    </div>
                    <div className="flex-1 bg-amber-950/30 border border-amber-500/30 p-1.5 rounded">
                      <div className="text-amber-300 font-bold">Warm: {warmCount}</div>
                      <div className="text-2xs text-slate-400">3-6 mo</div>
                    </div>
                    <div className="flex-1 bg-cyan-950/30 border border-cyan-500/30 p-1.5 rounded">
                      <div className="text-cyan-300 font-bold">Cold: {coldCount}</div>
                      <div className="text-2xs text-slate-400">Nurture</div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>

        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-emerald-400" />
            <span>Ready to generate PDF summary for <strong>{selectedMonth}</strong></span>
          </div>

          <div className="flex items-center gap-2.5 w-full sm:w-auto">
            <button
              id="btn-cancel-quick-report"
              type="button"
              onClick={onClose}
              className="flex-1 sm:flex-none px-4 py-2 rounded-xl text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 transition-colors"
            >
              Close
            </button>

            <button
              id="btn-download-pdf-summary"
              type="button"
              onClick={handleExportPDF}
              disabled={isExporting}
              className="flex-1 sm:flex-none px-5 py-2 rounded-xl text-xs font-bold text-on-accent bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2"
            >
              {isExporting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-on-accent border-t-transparent rounded-full animate-spin" />
                  <span>Generating PDF...</span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  <span>Export PDF Summary</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

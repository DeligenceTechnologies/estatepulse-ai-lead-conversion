import { jsPDF } from 'jspdf';

export interface ReportSourceItem {
  name: string;
  count: number;
  pct: number;
  qualifiedPct: number;
}

export interface ReportConfig {
  reportMonth: string;
  brokerageName: string;
  preparedBy: string;
  notes?: string;
  includeExecutiveSummary: boolean;
  includeSpeedToLead: boolean;
  includeSourceBreakdown: boolean;
  includeTemperatureFunnel: boolean;
  includeVoiceMetrics: boolean;
  includeRoiModel: boolean;
  includeRecentAppointments: boolean;
}

export interface ReportData {
  config: ReportConfig;
  metrics: {
    monthlyLeads: number;
    autonomousContactRate: string;
    avgFirstResponse: string;
    qualificationRate: string;
    appointmentConversion: string;
    agentTimeSaved: string;
    estimatedAddedGCI: string;
    totalCalls: number;
    callAnswerRate: string;
    totalAppointments: number;
    hotCount: number;
    warmCount: number;
    coldCount: number;
    sources: ReportSourceItem[];
    roi: {
      monthlyLeads: number;
      avgCommission: number;
      closeRate: number;
      estimatedConversations: number;
      estimatedQualified: number;
      estimatedAppointments: number;
      estimatedClosings: number;
      estimatedRevenue: number;
    };
    recentAppointments?: Array<{
      leadName: string;
      appointmentType: string;
      agentName: string;
      startTime: string;
    }>;
  };
}

export function generateMonthlyPerformancePDF(data: ReportData): void {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;
  let y = 0;

  const addHeader = (title: string, subtitle: string) => {
    // Top dark band
    doc.setFillColor(15, 23, 42); // slate-900
    doc.rect(0, 0, pageWidth, 28, 'F');

    // Emerald accent line
    doc.setFillColor(16, 185, 129); // emerald-500
    doc.rect(0, 28, pageWidth, 1.8, 'F');

    // Brand / Title
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(title, margin, 12);

    // Subtitle
    doc.setTextColor(148, 163, 184); // slate-400
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(subtitle, margin, 19);

    // Right-aligned Meta
    doc.setFontSize(8);
    doc.setTextColor(52, 211, 153); // emerald-400
    doc.text(`ESTATEPULSE AI REPORT`, pageWidth - margin, 11, { align: 'right' });
    doc.setTextColor(203, 213, 225);
    doc.text(`Exported: ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, pageWidth - margin, 18, { align: 'right' });

    y = 36;
  };

  const addFooter = (pageNum: number, totalPages: number) => {
    doc.setDrawColor(226, 232, 240); // slate-200
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(`Confidential • ${data.config.brokerageName} • Generated via EstatePulse AI Autonomous Lead Engine`, margin, pageHeight - 7);
    doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
  };

  const checkPageBreak = (neededHeight: number) => {
    if (y + neededHeight > pageHeight - 20) {
      doc.addPage();
      addHeader(
        `${data.config.brokerageName.toUpperCase()} — MONTHLY REPORT (CONT.)`,
        `Reporting Period: ${data.config.reportMonth} | Prepared for Leadership`
      );
    }
  };

  // ---------------- PAGE 1 ----------------
  addHeader(
    `${data.config.brokerageName.toUpperCase()} — MONTHLY PERFORMANCE REPORT`,
    `Reporting Period: ${data.config.reportMonth} | Prepared by: ${data.config.preparedBy}`
  );

  // Brokerage Overview Card
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(margin, y, contentWidth, 18, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`Brokerage: ${data.config.brokerageName}`, margin + 4, y + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Scope: Speed-to-lead audit, voice & SMS qualification, inbound source attribution, and revenue conversion model.`,
    margin + 4,
    y + 12
  );

  y += 23;

  // SECTION 1: EXECUTIVE KPI SUMMARY
  if (data.config.includeExecutiveSummary) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('1. Executive Performance Highlights', margin, y);
    y += 4;

    const cards = [
      {
        label: 'Autonomous Contact Rate',
        val: data.metrics.autonomousContactRate,
        sub: '<60s first touch SLA',
        bg: [240, 253, 250],
        accent: [13, 148, 136],
      },
      {
        label: 'Average Speed to Lead',
        val: data.metrics.avgFirstResponse,
        sub: 'Target: <60 seconds',
        bg: [236, 253, 245],
        accent: [16, 185, 129],
      },
      {
        label: 'Qualification Rate',
        val: data.metrics.qualificationRate,
        sub: 'Complete buyer profiles',
        bg: [239, 246, 255],
        accent: [37, 99, 235],
      },
      {
        label: 'Appointments Booked',
        val: `${data.metrics.totalAppointments}`,
        sub: `${data.metrics.appointmentConversion} conversion rate`,
        bg: [250, 245, 255],
        accent: [147, 51, 234],
      },
      {
        label: 'Agent Time Saved',
        val: data.metrics.agentTimeSaved,
        sub: 'Per agent / month',
        bg: [255, 251, 235],
        accent: [217, 119, 6],
      },
      {
        label: 'Estimated Added GCI',
        val: data.metrics.estimatedAddedGCI,
        sub: 'Forecasted pipeline',
        bg: [236, 253, 245],
        accent: [5, 150, 105],
      },
    ];

    const cardWidth = (contentWidth - 8) / 3;
    const cardHeight = 18;

    cards.forEach((card, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const cx = margin + col * (cardWidth + 4);
      const cy = y + row * (cardHeight + 3);

      doc.setFillColor(card.bg[0], card.bg[1], card.bg[2]);
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(cx, cy, cardWidth, cardHeight, 1.5, 1.5, 'FD');

      // Top colored indicator bar
      doc.setFillColor(card.accent[0], card.accent[1], card.accent[2]);
      doc.rect(cx, cy, cardWidth, 1.2, 'F');

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(card.label, cx + 3, cy + 5);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(card.accent[0], card.accent[1], card.accent[2]);
      doc.text(card.val, cx + 3, cy + 11.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(148, 163, 184);
      doc.text(card.sub, cx + 3, cy + 15.5);
    });

    y += 2 * (cardHeight + 3) + 4;
  }

  // SECTION 2: MARKETING CHANNEL DISTRIBUTION
  if (data.config.includeSourceBreakdown && data.metrics.sources.length > 0) {
    checkPageBreak(45);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('2. Inbound Marketing Source Attribution', margin, y);
    y += 4;

    // Table Header
    const tableY = y;
    doc.setFillColor(15, 23, 42);
    doc.rect(margin, tableY, contentWidth, 7, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    doc.text('Lead Source Channel', margin + 3, tableY + 4.8);
    doc.text('Leads Captured', margin + 65, tableY + 4.8, { align: 'center' });
    doc.text('Share of Volume', margin + 105, tableY + 4.8, { align: 'center' });
    doc.text('Qualification Rate', margin + 145, tableY + 4.8, { align: 'center' });
    doc.text('Speed to Lead SLA', pageWidth - margin - 3, tableY + 4.8, { align: 'right' });

    y += 7;

    data.metrics.sources.forEach((source, sIdx) => {
      const isEven = sIdx % 2 === 0;
      doc.setFillColor(isEven ? 255 : 248, isEven ? 255 : 250, isEven ? 255 : 252);
      doc.setDrawColor(241, 245, 249);
      doc.rect(margin, y, contentWidth, 6.5, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(30, 41, 59);
      doc.text(source.name, margin + 3, y + 4.5);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(71, 85, 105);
      doc.text(`${source.count}`, margin + 65, y + 4.5, { align: 'center' });
      doc.text(`${source.pct}%`, margin + 105, y + 4.5, { align: 'center' });
      
      // Color coded qual rate
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(16, 185, 129);
      doc.text(`${source.qualifiedPct}%`, margin + 145, y + 4.5, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 116, 139);
      doc.text('< 45s (Auto-Call)', pageWidth - margin - 3, y + 4.5, { align: 'right' });

      y += 6.5;
    });

    y += 5;
  }

  // SECTION 3: LEAD QUALITY & TEMPERATURE FUNNEL
  if (data.config.includeTemperatureFunnel) {
    checkPageBreak(38);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('3. Lead Temperature & Readiness Segmentation', margin, y);
    y += 4;

    const totalGraded = Math.max(1, data.metrics.hotCount + data.metrics.warmCount + data.metrics.coldCount);
    const hotPct = Math.round((data.metrics.hotCount / totalGraded) * 100);
    const warmPct = Math.round((data.metrics.warmCount / totalGraded) * 100);
    const coldPct = Math.round((data.metrics.coldCount / totalGraded) * 100);

    const tempCards = [
      {
        title: 'HOT LEADS (Score 75-100)',
        count: data.metrics.hotCount,
        pct: `${hotPct}%`,
        desc: 'Pre-approved or cash, moving <60 days. Immediate agent live transfer triggered.',
        border: [244, 63, 94], // rose
        bg: [255, 241, 242],
      },
      {
        title: 'WARM LEADS (Score 45-74)',
        count: data.metrics.warmCount,
        pct: `${warmPct}%`,
        desc: 'Moving in 3-6 months, browsing inventory. Placed in multi-touch SMS drip.',
        border: [245, 158, 11], // amber
        bg: [254, 243, 199],
      },
      {
        title: 'COLD LEADS (Score 0-44)',
        count: data.metrics.coldCount,
        pct: `${coldPct}%`,
        desc: 'Long-term research or missing criteria. Long-term automated nurture sequence.',
        border: [6, 182, 212], // cyan
        bg: [236, 254, 255],
      },
    ];

    const tWidth = (contentWidth - 6) / 3;
    tempCards.forEach((tc, tIdx) => {
      const tx = margin + tIdx * (tWidth + 3);
      doc.setFillColor(tc.bg[0], tc.bg[1], tc.bg[2]);
      doc.setDrawColor(tc.border[0], tc.border[1], tc.border[2]);
      doc.roundedRect(tx, y, tWidth, 24, 1.5, 1.5, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(tc.border[0], tc.border[1], tc.border[2]);
      doc.text(tc.title, tx + 3, y + 5);

      doc.setFontSize(13);
      doc.setTextColor(15, 23, 42);
      doc.text(`${tc.count}`, tx + 3, y + 12);
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`(${tc.pct} of total)`, tx + 16, y + 11.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(71, 85, 105);
      const splitDesc = doc.splitTextToSize(tc.desc, tWidth - 6);
      doc.text(splitDesc, tx + 3, y + 16);
    });

    y += 28;
  }

  // ---------------- PAGE BREAK OR CONTINUE ----------------
  // Check if we need a new page for Section 4 and 5
  checkPageBreak(50);

  // SECTION 4: BROKERAGE ROI & REVENUE FORECAST (PRD Section 47)
  if (data.config.includeRoiModel) {
    checkPageBreak(48);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('4. Brokerage Revenue Forecast & Economic Model (PRD Sec. 47)', margin, y);
    y += 4;

    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(16, 185, 129);
    doc.roundedRect(margin, y, contentWidth, 38, 2, 2, 'FD');

    // Colored banner on top of ROI box
    doc.setFillColor(16, 185, 129);
    doc.rect(margin, y, contentWidth, 1.5, 'F');

    // Inputs line
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(15, 23, 42);
    doc.text('Input Baseline Parameters:', margin + 4, y + 6);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text(
      `Monthly Inbound Leads: ${data.metrics.roi.monthlyLeads}  |  Avg Commission: $${data.metrics.roi.avgCommission.toLocaleString()}  |  Qualified Lead Close Rate: ${data.metrics.roi.closeRate}%`,
      margin + 4,
      y + 11
    );

    // Funnel columns
    const funnelSteps = [
      { label: 'Total Inbound', val: `${data.metrics.roi.monthlyLeads}`, sub: '100%' },
      { label: 'Contacted (<60s)', val: `${data.metrics.roi.estimatedConversations}`, sub: '92% reach' },
      { label: 'Fully Qualified', val: `${data.metrics.roi.estimatedQualified}`, sub: '38% qual' },
      { label: 'Appointments', val: `${data.metrics.roi.estimatedAppointments}`, sub: '45% to appt' },
      { label: 'Closed Deals', val: `${data.metrics.roi.estimatedClosings}`, sub: `${data.metrics.roi.closeRate}% close` },
      { label: 'Est. Added GCI', val: `$${data.metrics.roi.estimatedRevenue.toLocaleString()}`, sub: 'Net Value', highlight: true },
    ];

    const fWidth = (contentWidth - 10) / funnelSteps.length;
    funnelSteps.forEach((st, fIdx) => {
      const fx = margin + 3 + fIdx * (fWidth + 1);
      const fy = y + 16;

      if (st.highlight) {
        doc.setFillColor(236, 253, 245);
        doc.setDrawColor(16, 185, 129);
        doc.roundedRect(fx, fy, fWidth, 18, 1, 1, 'FD');
      } else {
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(fx, fy, fWidth, 18, 1, 1, 'FD');
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6);
      if (st.highlight) {
        doc.setTextColor(5, 150, 105);
      } else {
        doc.setTextColor(100, 116, 139);
      }
      doc.text(st.label, fx + fWidth / 2, fy + 4.5, { align: 'center' });

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      if (st.highlight) {
        doc.setTextColor(4, 120, 87);
      } else {
        doc.setTextColor(15, 23, 42);
      }
      doc.text(st.val, fx + fWidth / 2, fy + 10.5, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6);
      if (st.highlight) {
        doc.setTextColor(16, 185, 129);
      } else {
        doc.setTextColor(148, 163, 184);
      }
      doc.text(st.sub, fx + fWidth / 2, fy + 15, { align: 'center' });
    });

    y += 43;
  }

  // EXECUTIVE NOTES (if provided)
  if (data.config.notes && data.config.notes.trim().length > 0) {
    checkPageBreak(25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text('Executive Analyst Notes & Strategic Directives', margin, y);
    y += 4;

    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(margin, y, contentWidth, 16, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    const splitNotes = doc.splitTextToSize(data.config.notes, contentWidth - 8);
    doc.text(splitNotes, margin + 4, y + 5.5);

    y += 20;
  }

  // Compliance & SLA Audit Statement
  checkPageBreak(18);
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(margin, y, contentWidth, 14, 1.5, 1.5, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(15, 23, 42);
  doc.text('Autonomous Voice & TCPA Compliance Audit Confirmation', margin + 4, y + 4.8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text(
    'All outbound voice calls and SMS dispatches were executed within approved business hours (8:30 AM – 7:30 PM CST) adhering to DNC list enforcement, two-way consent verification, and automatic human takeover protocols.',
    margin + 4,
    y + 9.5
  );

  // Add footers to all pages
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addFooter(i, totalPages);
  }

  // Trigger browser download
  const cleanMonth = data.config.reportMonth.replace(/\s+/g, '_');
  const filename = `${data.config.brokerageName.replace(/\s+/g, '_')}_Monthly_Performance_${cleanMonth}.pdf`;
  doc.save(filename);
}

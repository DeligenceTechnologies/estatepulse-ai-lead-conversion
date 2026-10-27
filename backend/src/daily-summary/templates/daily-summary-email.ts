import { detailRows, escapeHtml, note, paragraph, renderEmailLayout } from '@/common/mail/email-layout';
import type { DailySummaryStats } from '../daily-summary.stats';

export interface DailySummaryEmailInput {
  firstName: string;
  organizationName: string;
  /** The local day, already formatted, e.g. "Tue, 27 Oct 2026". */
  dayLabel: string;
  /** What part of the day the numbers cover, e.g. "midnight to 9:00 PM" or "the whole day". */
  coverage: string;
  stats: DailySummaryStats;
  dashboardUrl?: string;
  settingsUrl?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Four headline numbers side by side; email clients need a table for that. */
function tiles(items: [label: string, value: number][]): string {
  const cells = items
    .map(
      ([label, value]) => `
                  <td width="25%" style="padding:4px;">
                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 8px;text-align:center;">
                      <div style="font-size:22px;line-height:28px;font-weight:700;color:#0f172a;">${value.toLocaleString('en-US')}</div>
                      <div style="font-size:11px;line-height:16px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">${escapeHtml(label)}</div>
                    </div>
                  </td>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px -4px 16px;"><tr>${cells}
                </tr></table>`;
}

const heading = (text: string) =>
  `<p style="margin:20px 0 8px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.4px;">${escapeHtml(text)}</p>`;

/**
 * The owners' end-of-day email: what came in, what the AI did, what is booked,
 * and what needs a person. Source names are user input, so they are escaped.
 */
export function dailySummaryEmail(input: DailySummaryEmailInput): { subject: string; html: string; text: string } {
  const { stats: s } = input;
  const subject = `Daily summary for ${input.organizationName}: ${plural(s.leads.total, 'new lead')}, ${plural(s.meetings.booked, 'meeting')} booked`;

  const sources = s.leads.topSources.map((src) => `${src.name}: ${src.count.toLocaleString('en-US')}`).join(', ');
  const attentionCount = s.attention.needsReview + s.attention.unassigned;

  const leadRows = detailRows([
    ['New leads', escapeHtml(`${plural(s.leads.total, 'lead')}${s.leads.hot ? `, ${s.leads.hot.toLocaleString('en-US')} hot` : ''}`)],
    ['Top sources', sources ? escapeHtml(sources) : null],
  ]);
  const outreachRows = detailRows([
    [
      'AI calls',
      escapeHtml(
        `${plural(s.calls.total, 'call')}: ${s.calls.connected.toLocaleString('en-US')} connected, ` +
          `${s.calls.noAnswer.toLocaleString('en-US')} no answer, ${s.calls.failed.toLocaleString('en-US')} failed`,
      ),
    ],
    ['Talk time', s.calls.talkSeconds ? escapeHtml(duration(s.calls.talkSeconds)) : null],
    ['Texts', escapeHtml(`${plural(s.texts.sent, 'text')} sent, ${plural(s.texts.replies, 'reply', 'replies')} received`)],
  ]);
  const meetingRows = detailRows([
    ['Booked today', escapeHtml(plural(s.meetings.booked, 'meeting'))],
    ['Canceled today', s.meetings.canceled ? escapeHtml(plural(s.meetings.canceled, 'meeting')) : null],
    ['Tomorrow', escapeHtml(plural(s.meetings.tomorrow, 'meeting'))],
  ]);
  const attentionRows = attentionCount
    ? heading('Needs your attention') +
      detailRows([
        ['Waiting for review', s.attention.needsReview ? escapeHtml(plural(s.attention.needsReview, 'lead')) : null],
        ['Not assigned to anyone', s.attention.unassigned ? escapeHtml(plural(s.attention.unassigned, 'lead')) : null],
      ])
    : '';

  const html = renderEmailLayout({
    subject,
    preheader: `${plural(s.leads.total, 'new lead')}, ${plural(s.calls.total, 'call')}, ${plural(s.meetings.booked, 'meeting')} booked.`,
    heading: `Hi ${input.firstName}, here is your day`,
    bodyHtml:
      paragraph(`${escapeHtml(input.organizationName)} on <strong>${escapeHtml(input.dayLabel)}</strong>:`) +
      tiles([
        ['New leads', s.leads.total],
        ['AI calls', s.calls.total],
        ['Texts sent', s.texts.sent],
        ['Meetings', s.meetings.booked],
      ]) +
      heading('Leads') +
      leadRows +
      heading('Outreach') +
      outreachRows +
      heading('Meetings') +
      meetingRows +
      attentionRows,
    ...(input.dashboardUrl ? { button: { label: 'Open dashboard', url: input.dashboardUrl } } : {}),
    afterButtonHtml: note(
      input.settingsUrl
        ? `Sent to the owners of ${escapeHtml(input.organizationName)} every day. ` +
            `<a href="${escapeHtml(input.settingsUrl)}" style="color:#059669;">Change the time or turn it off in Settings</a>.`
        : `Sent to the owners of ${escapeHtml(input.organizationName)} every day. Turn it off in Settings.`,
    ),
    footer: `Covers ${input.coverage} on ${input.dayLabel}, in ${input.organizationName}'s timezone.`,
  });

  const text = [
    `Hi ${input.firstName}, here is your day.`,
    `${input.organizationName} on ${input.dayLabel}:`,
    '',
    'LEADS',
    `New leads: ${plural(s.leads.total, 'lead')}${s.leads.hot ? `, ${s.leads.hot} hot` : ''}`,
    ...(sources ? [`Top sources: ${sources}`] : []),
    '',
    'OUTREACH',
    `AI calls: ${plural(s.calls.total, 'call')} (${s.calls.connected} connected, ${s.calls.noAnswer} no answer, ${s.calls.failed} failed)`,
    ...(s.calls.talkSeconds ? [`Talk time: ${duration(s.calls.talkSeconds)}`] : []),
    `Texts: ${plural(s.texts.sent, 'text')} sent, ${plural(s.texts.replies, 'reply', 'replies')} received`,
    '',
    'MEETINGS',
    `Booked today: ${plural(s.meetings.booked, 'meeting')}`,
    ...(s.meetings.canceled ? [`Canceled today: ${plural(s.meetings.canceled, 'meeting')}`] : []),
    `Tomorrow: ${plural(s.meetings.tomorrow, 'meeting')}`,
    ...(attentionCount
      ? [
          '',
          'NEEDS YOUR ATTENTION',
          ...(s.attention.needsReview ? [`Waiting for review: ${plural(s.attention.needsReview, 'lead')}`] : []),
          ...(s.attention.unassigned ? [`Not assigned to anyone: ${plural(s.attention.unassigned, 'lead')}`] : []),
        ]
      : []),
    ...(input.dashboardUrl ? ['', `Open dashboard: ${input.dashboardUrl}`] : []),
    '',
    `Covers ${input.coverage} on ${input.dayLabel}. Sent to the owners of ${input.organizationName} every day; change the time or turn it off in Settings.`,
  ].join('\n');

  return { subject, html, text };
}

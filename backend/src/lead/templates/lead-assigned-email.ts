import { detailRows, escapeHtml, note, paragraph, renderEmailLayout } from '@/common/mail/email-layout';

export interface LeadAssignedEmailInput {
  agentFirstName: string;
  organizationName: string;
  /** Who handed it over, e.g. "Ravi Sharma", or null when the AI did. */
  assignedByName: string | null;
  reassigned: boolean;
  /** The agent took the lead themselves. */
  selfAssigned?: boolean;
  lead: {
    name: string;
    phone: string | null;
    email: string | null;
    source: string | null;
    status: string;
    temperature: string | null;
    location: string | null;
    timeline: string | null;
    summary: string | null;
  };
  /** Opens the lead in the app; the button is left out when unknown. */
  leadUrl?: string;
}

const SUMMARY_MAX = 400;

/** Snake-case enum values as words: "appointment_booked" → "Appointment booked". */
const words = (value: string): string => {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const clip = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text);

/**
 * Tells an agent a lead is now theirs: who it is, how to reach them, and a
 * link straight to it. Every lead field is someone's form input, so all of it
 * is escaped.
 */
export function leadAssignedEmail(input: LeadAssignedEmailInput): { subject: string; html: string; text: string } {
  const { lead } = input;
  const subject = `New lead assigned to you: ${lead.name}`;
  const verb = input.reassigned ? 'reassigned' : 'assigned';
  const lead1 = input.selfAssigned
    ? `You ${verb} a lead to yourself in ${input.organizationName}.`
    : input.assignedByName
    ? `${input.assignedByName} ${verb} you a lead in ${input.organizationName}.`
    : `The AI assistant ${verb} you a lead in ${input.organizationName} after booking a meeting during its call.`;
  const status = [words(lead.status), lead.temperature ? words(lead.temperature) : null].filter(Boolean).join(' · ');

  const tel = lead.phone ? `<a href="tel:${escapeHtml(lead.phone.replace(/[^\d+]/g, ''))}" style="color:#059669;">${escapeHtml(lead.phone)}</a>` : null;
  const mail = lead.email ? `<a href="mailto:${escapeHtml(lead.email)}" style="color:#059669;">${escapeHtml(lead.email)}</a>` : null;

  const html = renderEmailLayout({
    subject,
    preheader: `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''}${lead.source ? ` · from ${lead.source}` : ''}`,
    heading: `Hi ${input.agentFirstName},`,
    bodyHtml:
      paragraph(escapeHtml(lead1)) +
      detailRows([
        ['Lead', `<strong>${escapeHtml(lead.name)}</strong>`],
        ['Phone', tel],
        ['Email', mail],
        ['Source', lead.source ? escapeHtml(lead.source) : null],
        ['Status', escapeHtml(status)],
        ['Location', lead.location ? escapeHtml(lead.location) : null],
        ['Timeline', lead.timeline ? escapeHtml(lead.timeline) : null],
        ['AI summary', lead.summary ? escapeHtml(clip(lead.summary)) : null],
      ]),
    ...(input.leadUrl ? { button: { label: 'Open lead', url: input.leadUrl } } : {}),
    afterButtonHtml: note('Reach out soon: leads go cold fast. The lead stays in your list under <em>My Leads</em>.'),
    footer: `You received this email because a lead was assigned to you in ${input.organizationName} on EstatePulse.`,
  });

  const text = [
    `Hi ${input.agentFirstName},`,
    '',
    lead1,
    '',
    `Lead: ${lead.name}`,
    ...(lead.phone ? [`Phone: ${lead.phone}`] : []),
    ...(lead.email ? [`Email: ${lead.email}`] : []),
    ...(lead.source ? [`Source: ${lead.source}`] : []),
    `Status: ${status}`,
    ...(lead.location ? [`Location: ${lead.location}`] : []),
    ...(lead.timeline ? [`Timeline: ${lead.timeline}`] : []),
    ...(lead.summary ? ['', `AI summary: ${clip(lead.summary)}`] : []),
    ...(input.leadUrl ? ['', `Open lead: ${input.leadUrl}`] : []),
  ].join('\n');

  return { subject, html, text };
}

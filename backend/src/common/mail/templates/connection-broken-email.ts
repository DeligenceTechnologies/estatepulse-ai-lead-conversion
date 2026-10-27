import { detailRows, escapeHtml, note, paragraph, renderEmailLayout } from '@/common/mail/email-layout';

export interface ConnectionBrokenEmailInput {
  firstName: string;
  organizationName: string;
  /** e.g. "Google Sheets", "HubSpot". */
  providerLabel: string;
  /** The connected account, when known: an email or account name. */
  account: string | null;
  /** What stops working until it is reconnected. */
  impact: string;
  reconnectUrl?: string;
}

/** Tells an owner a connection stopped working and has to be reconnected. */
export function connectionBrokenEmail(input: ConnectionBrokenEmailInput): { subject: string; html: string; text: string } {
  const subject = `Action needed: ${input.providerLabel} disconnected from ${input.organizationName}`;
  const intro = `${input.providerLabel} stopped accepting the connection for ${input.organizationName}. Access was revoked, expired, or the password changed.`;

  const html = renderEmailLayout({
    subject,
    preheader: `Reconnect ${input.providerLabel} to resume. ${input.impact}`,
    heading: `Hi ${input.firstName},`,
    bodyHtml:
      paragraph(escapeHtml(intro)) +
      detailRows([
        ['Connection', `<strong>${escapeHtml(input.providerLabel)}</strong>`],
        ['Account', input.account ? escapeHtml(input.account) : null],
        ['Paused', escapeHtml(input.impact)],
      ]),
    ...(input.reconnectUrl ? { button: { label: `Reconnect ${input.providerLabel}`, url: input.reconnectUrl } } : {}),
    afterButtonHtml: note('Nothing is lost: once it is reconnected, everything picks up where it stopped.'),
    footer: `You received this email because you are an owner of ${input.organizationName} on EstatePulse.`,
  });

  const text = [
    `Hi ${input.firstName},`,
    '',
    intro,
    '',
    `Connection: ${input.providerLabel}`,
    ...(input.account ? [`Account: ${input.account}`] : []),
    `Paused: ${input.impact}`,
    ...(input.reconnectUrl ? ['', `Reconnect: ${input.reconnectUrl}`] : []),
  ].join('\n');

  return { subject, html, text };
}

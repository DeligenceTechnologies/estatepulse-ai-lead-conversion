import { escapeHtml, note, paragraph, renderEmailLayout } from '@/common/mail/email-layout';

export interface VerifyEmailInput {
  firstName: string;
  organizationName: string;
  verifyUrl: string;
  expiresInHours: number;
}

/** Sent at sign-up: the account cannot be signed into until this link is opened. */
export function verifyEmail(input: VerifyEmailInput): { subject: string; html: string; text: string } {
  const subject = 'Confirm your email for EstatePulse';
  const hours = `${input.expiresInHours} hours`;

  const html = renderEmailLayout({
    subject,
    preheader: `Confirm your email to finish setting up ${input.organizationName}.`,
    heading: `Welcome, ${input.firstName}!`,
    bodyHtml:
      paragraph(
        `Thanks for creating <strong>${escapeHtml(input.organizationName)}</strong> on EstatePulse. ` +
          'Confirm this is your email address to activate your account and sign in.',
      ) + paragraph(`The link works once and expires in <strong>${escapeHtml(hours)}</strong>.`),
    button: { label: 'Confirm email and sign in', url: input.verifyUrl },
    afterButtonHtml: note('If you did not sign up for EstatePulse, ignore this email: no account will be activated.'),
    footer: 'You received this email because this address was used to create an EstatePulse account.',
  });

  const text = [
    `Welcome, ${input.firstName}!`,
    '',
    `Thanks for creating ${input.organizationName} on EstatePulse.`,
    `Confirm your email to activate your account (the link works once and expires in ${hours}):`,
    '',
    input.verifyUrl,
    '',
    'If you did not sign up for EstatePulse, ignore this email: no account will be activated.',
  ].join('\n');

  return { subject, html, text };
}

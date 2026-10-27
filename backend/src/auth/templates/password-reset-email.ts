import { escapeHtml, note, paragraph, renderEmailLayout } from '@/common/mail/email-layout';

export interface PasswordResetEmailInput {
  firstName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

/** The "forgot password" link. Says how long it lasts and that ignoring it is safe. */
export function passwordResetEmail(input: PasswordResetEmailInput): { subject: string; html: string; text: string } {
  const subject = 'Reset your EstatePulse password';
  const minutes = `${input.expiresInMinutes} minutes`;

  const html = renderEmailLayout({
    subject,
    preheader: `Use this link within ${minutes} to choose a new password.`,
    heading: `Hi ${input.firstName},`,
    bodyHtml: paragraph(
      'We received a request to reset the password for your EstatePulse account. ' +
        `Click the button below to choose a new one. The link works once and expires in <strong>${escapeHtml(minutes)}</strong>.`,
    ),
    button: { label: 'Reset password', url: input.resetUrl },
    afterButtonHtml: note(
      'If you did not ask for this, you can ignore this email: your password stays the same. ' +
        'Never share this link with anyone.',
    ),
    footer: 'You received this email because a password reset was requested for your EstatePulse account.',
  });

  const text = [
    `Hi ${input.firstName},`,
    '',
    'We received a request to reset the password for your EstatePulse account.',
    `Open this link to choose a new one (it works once and expires in ${minutes}):`,
    '',
    input.resetUrl,
    '',
    'If you did not ask for this, you can ignore this email: your password stays the same.',
  ].join('\n');

  return { subject, html, text };
}

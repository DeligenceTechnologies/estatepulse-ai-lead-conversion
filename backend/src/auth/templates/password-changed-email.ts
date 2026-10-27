import { escapeHtml, note, paragraph, renderEmailLayout } from '@/common/mail/email-layout';

/** How the password changed: from the profile menu, through a reset link, or by an administrator. */
export type PasswordChangeKind = 'self' | 'reset' | 'admin';

export interface PasswordChangedEmailInput {
  firstName: string;
  organizationName: string;
  kind: PasswordChangeKind;
  changedAt: Date;
  /** The user's own timezone, so the time reads as theirs. */
  timezone: string;
  ipAddress?: string;
  /** Where to start a reset if this was not them; the button is left out when unknown. */
  forgotPasswordUrl?: string;
}

const LEAD: Record<PasswordChangeKind, (org: string) => string> = {
  self: () => 'The password for your EstatePulse account was just changed.',
  reset: () => 'The password for your EstatePulse account was just reset using a password reset link.',
  admin: (org) => `An administrator of ${org} has changed the password for your EstatePulse account.`,
};

function formatWhen(at: Date, timezone: string): string {
  // dateStyle/timeStyle cannot be combined with timeZoneName, so the fields are spelled out.
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(at);
  }
}

/**
 * The security notice after any password change. It never contains a password:
 * after an administrator's change the user gets the new one from them, or
 * picks their own through "Forgot password".
 */
export function passwordChangedEmail(input: PasswordChangedEmailInput): { subject: string; html: string; text: string } {
  const subject = 'Your EstatePulse password was changed';
  const lead = LEAD[input.kind](input.organizationName);
  const when = formatWhen(input.changedAt, input.timezone);
  const next =
    input.kind === 'admin'
      ? 'Ask your administrator for the new password, or choose your own with "Forgot password" on the sign-in page.'
      : 'You can now sign in with your new password.';
  const warning =
    input.kind === 'admin'
      ? 'If you were not expecting this, contact your administrator.'
      : 'If you did not make this change, reset your password now and tell your administrator.';

  const details = [
    `<strong>When:</strong> ${escapeHtml(when)}`,
    ...(input.ipAddress && input.kind !== 'admin' ? [`<strong>IP address:</strong> ${escapeHtml(input.ipAddress)}`] : []),
  ].join('<br>');

  const html = renderEmailLayout({
    subject,
    preheader: lead,
    heading: `Hi ${input.firstName},`,
    bodyHtml:
      paragraph(escapeHtml(lead)) +
      paragraph(details) +
      paragraph(`For your security, you have been signed out on all devices. ${escapeHtml(next)}`),
    ...(input.forgotPasswordUrl && input.kind !== 'admin'
      ? { button: { label: 'This was not me: reset password', url: input.forgotPasswordUrl } }
      : {}),
    afterButtonHtml: note(escapeHtml(warning)),
    footer: 'This is a security notice about your EstatePulse account. It is sent for every password change and cannot be turned off.',
  });

  const text = [
    `Hi ${input.firstName},`,
    '',
    lead,
    '',
    `When: ${when}`,
    ...(input.ipAddress && input.kind !== 'admin' ? [`IP address: ${input.ipAddress}`] : []),
    '',
    `For your security, you have been signed out on all devices. ${next}`,
    '',
    warning,
    ...(input.forgotPasswordUrl && input.kind !== 'admin' ? ['', `Reset your password: ${input.forgotPasswordUrl}`] : []),
  ].join('\n');

  return { subject, html, text };
}

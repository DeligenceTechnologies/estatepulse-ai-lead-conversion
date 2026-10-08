export interface WelcomeEmailInput {
  firstName: string;
  organizationName: string;
  roleName: string;
  email: string;
  password: string;
  /** The sign-in page; the button is left out when unknown. */
  loginUrl?: string;
}

/** Every value is user-supplied, so it is escaped before it goes into HTML. */
const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * The account-created email: who invited them, the sign-in email and the
 * generated password, and a nudge to change it. Table layout and inline styles
 * only, as email clients ignore <style> blocks and most modern CSS.
 */
export function welcomeEmail(input: WelcomeEmailInput): { subject: string; html: string; text: string } {
  const firstName = escape(input.firstName);
  const organization = escape(input.organizationName);
  const role = escape(input.roleName);
  const email = escape(input.email);
  const password = escape(input.password);
  const loginUrl = input.loginUrl ? escape(input.loginUrl) : undefined;

  const subject = `Your ${input.organizationName} account on EstatePulse`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:#059669;padding:20px 28px;">
              <span style="font-size:18px;font-weight:700;color:#ffffff;">EstatePulse</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 12px;font-size:20px;line-height:28px;color:#0f172a;">Welcome, ${firstName}!</h1>
              <p style="margin:0 0 20px;font-size:14px;line-height:22px;color:#334155;">
                An account has been created for you at <strong>${organization}</strong> as <strong>${role}</strong>.
                Use the details below to sign in.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;">Email</div>
                    <div style="font-size:15px;color:#0f172a;margin-top:2px;">${email}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 16px;">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;">Temporary password</div>
                    <div style="font-size:16px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-weight:700;color:#0f172a;margin-top:2px;letter-spacing:1px;">${password}</div>
                  </td>
                </tr>
              </table>
${
  loginUrl
    ? `
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px;">
                <tr>
                  <td style="border-radius:8px;background:#059669;">
                    <a href="${loginUrl}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Sign in to EstatePulse</a>
                  </td>
                </tr>
              </table>`
    : ''
}
              <p style="margin:20px 0 0;font-size:13px;line-height:20px;color:#475569;">
                For your security, change this password after you sign in
                (profile menu &rarr; <em>Change password</em>), and do not share it with anyone.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:18px;color:#94a3b8;">
              You received this email because an administrator of ${organization} added you.
              If you were not expecting it, you can ignore it.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Welcome, ${input.firstName}!`,
    '',
    `An account has been created for you at ${input.organizationName} as ${input.roleName}.`,
    '',
    `Email: ${input.email}`,
    `Temporary password: ${input.password}`,
    ...(input.loginUrl ? ['', `Sign in: ${input.loginUrl}`] : []),
    '',
    'For your security, change this password after you sign in, and do not share it with anyone.',
  ].join('\n');

  return { subject, html, text };
}

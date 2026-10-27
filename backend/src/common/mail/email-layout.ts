/** Everything interpolated into an email's HTML goes through this first. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface EmailLayoutInput {
  /** Plain text; escaped here. */
  subject: string;
  /** Inbox preview line; plain text, escaped here. */
  preheader: string;
  /** Plain text; escaped here. */
  heading: string;
  /** Already-escaped HTML for the body, between the heading and the button. */
  bodyHtml: string;
  button?: { label: string; url: string };
  /** Already-escaped HTML shown under the button. */
  afterButtonHtml?: string;
  /** Plain text; escaped here. */
  footer: string;
}

/**
 * The shell every account email shares. Table layout and inline styles only,
 * as email clients ignore <style> blocks and most modern CSS.
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const button = input.button
    ? `
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px;">
                <tr>
                  <td style="border-radius:8px;background:#059669;">
                    <a href="${escapeHtml(input.button.url)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(input.button.label)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:12px 0 0;font-size:12px;line-height:18px;color:#64748b;word-break:break-all;">
                If the button does not work, copy this link into your browser:<br>
                <a href="${escapeHtml(input.button.url)}" style="color:#059669;">${escapeHtml(input.button.url)}</a>
              </p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
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
              <h1 style="margin:0 0 12px;font-size:20px;line-height:28px;color:#0f172a;">${escapeHtml(input.heading)}</h1>
              ${input.bodyHtml}${button}${input.afterButtonHtml ?? ''}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:18px;color:#94a3b8;">
              ${escapeHtml(input.footer)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A body paragraph from already-escaped HTML. */
export const paragraph = (html: string): string =>
  `<p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#334155;">${html}</p>`;

/** A muted note from already-escaped HTML. */
export const note = (html: string): string =>
  `<p style="margin:20px 0 0;font-size:13px;line-height:20px;color:#475569;">${html}</p>`;

/** A label/value list; labels are plain text, values already-escaped HTML. Rows without a value are left out. */
export function detailRows(rows: [label: string, valueHtml: string | null | undefined][]): string {
  const cells = rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(
      ([label, value], i, all) => `
                <tr>
                  <td style="padding:10px 16px;${i < all.length - 1 ? 'border-bottom:1px solid #e2e8f0;' : ''}">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;">${escapeHtml(label)}</div>
                    <div style="font-size:14px;line-height:20px;color:#0f172a;margin-top:2px;">${value}</div>
                  </td>
                </tr>`,
    )
    .join('');
  return cells
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">${cells}
              </table>`
    : '';
}

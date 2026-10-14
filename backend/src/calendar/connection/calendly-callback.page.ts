export interface CalendlyCallbackResult {
  ok: boolean;
  message: string;
}

const MESSAGE_SOURCE = 'estatepulse:calendly';

export function renderCalendlyCallbackPage(result: CalendlyCallbackResult, appUrl?: string): string {
  const appOrigin = originOf(appUrl);
  const fallback = appUrl
    ? `${appUrl.replace(/\/+$/, '')}/settings?${new URLSearchParams({ tab: 'calendar', calendar: result.ok ? 'connected' : 'failed' })}`
    : null;

  const payload = scriptJson({
    message: { source: MESSAGE_SOURCE, ok: result.ok, message: result.message },
    targetOrigin: appOrigin ?? '*',
    fallback,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calendly ${result.ok ? 'connected' : 'not connected'}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #020617; color: #e2e8f0; font: 14px/1.5 system-ui, sans-serif; }
  main { max-width: 360px; padding: 24px; text-align: center; }
  h1 { font-size: 16px; margin: 0 0 8px; color: ${result.ok ? '#6ee7b7' : '#fda4af'}; }
  p { margin: 0; color: #94a3b8; }
  button { margin-top: 16px; padding: 8px 16px; border: 1px solid #334155; border-radius: 8px; background: #0f172a; color: #e2e8f0; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>${result.ok ? 'Calendly connected' : 'Calendly was not connected'}</h1>
  <p>${escapeHtml(result.message)}</p>
  ${result.ok ? '' : '<button type="button" onclick="window.close()">Close</button>'}
</main>
<script>
  (function () {
    var data = ${payload};
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(data.message, data.targetOrigin);
      if (data.message.ok) window.close();
    } else if (data.fallback && data.message.ok) {
      window.location.replace(data.fallback);
    }
  })();
</script>
</body>
</html>`;
}

function originOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

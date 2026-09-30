import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { CalendarConnectionsService } from './calendar-connections.service';

/**
 * Where Calendly sends the browser back after consent.
 *
 * Deliberately UNGUARDED: this is a top-level browser navigation triggered by
 * Calendly, carrying no Authorization header and no cookie we set. The signed
 * state is what authenticates it — see CalendarConnectionsService.completeOAuth,
 * which verifies an HMAC-style nonce hash against the row and expires the
 * attempt after fifteen minutes. The organization is discovered from that row
 * and never read from the request.
 *
 * It answers with a tiny HTML page rather than a redirect because the SPA has no
 * URL-based routing: a full-page redirect back into the app would drop the
 * agent wherever the default view happens to be. The page posts its result to
 * the opener and closes itself.
 */
@Controller('api/calendly')
export class CalendlyOAuthController {
  constructor(
    private readonly connections: CalendarConnectionsService,
    private readonly config: ConfigService,
  ) {}

  @Get('oauth/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) return this.render(res, false, `Calendly reported: ${error}`);
    if (!code || !state) return this.render(res, false, 'Missing authorization code');

    try {
      await this.connections.completeOAuth(state, code);
      return this.render(res, true, null);
    } catch (err) {
      // The message is shown to the person who just clicked Allow, so it has to
      // be readable; the detail is already logged upstream.
      const message = err instanceof Error ? err.message : 'Could not finish connecting';
      return this.render(res, false, message);
    }
  }

  /**
   * The result page.
   *
   * Two things here are easy to get wrong and fail silently:
   *
   *  1. helmet() is applied globally in server.ts, and its default
   *     `default-src 'self'` blocks inline <script>. Without the per-response
   *     CSP below the page renders, does nothing, and looks exactly like a
   *     broken popup. The nonce is what makes this one inline script legal
   *     without loosening the policy for anything else.
   *  2. postMessage is given the SPA's exact origin, never '*'. In production
   *     the app and the API are different hosts, and '*' would hand the result
   *     to whatever page happened to open this one.
   */
  private render(res: Response, ok: boolean, message: string | null): void {
    const nonce = randomBytes(16).toString('base64');
    const appOrigin = new URL(this.config.getOrThrow<string>('PUBLIC_APP_URL')).origin;

    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Never cache an authorization outcome.
    res.setHeader('Cache-Control', 'no-store');

    const heading = ok ? 'Calendar connected' : 'Could not connect';
    const detail = ok
      ? 'You can close this window.'
      : (message ?? 'Something went wrong. Please try again.');

    res.status(ok ? 200 : 400).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${heading}</title>
<style nonce="${nonce}">
  body { margin:0; display:grid; place-items:center; min-height:100vh;
         background:#020617; color:#e2e8f0;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .card { text-align:center; padding:32px 40px; border-radius:16px;
          background:#0f172a; border:1px solid #1e293b; max-width:360px; }
  h1 { font-size:16px; margin:0 0 8px; color:#fff; }
  p  { margin:0; color:#94a3b8; }
</style>
</head>
<body>
  <div class="card"><h1>${heading}</h1><p>${escapeHtml(detail)}</p></div>
  <script nonce="${nonce}">
    (function () {
      var result = { source: 'estatepulse:calendly', ok: ${ok ? 'true' : 'false'} };
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(result, ${JSON.stringify(appOrigin)});
          window.close();
          return;
        }
      } catch (e) { /* cross-origin opener check can throw; fall through */ }
      // No opener: the popup was blocked and this is a top-level tab. Hand the
      // outcome back through the URL instead; the SPA reads it once at boot and
      // strips it, so it never becomes a route.
      location.replace(${JSON.stringify(appOrigin)} + '/?calendly=' + (${ok ? 'true' : 'false'} ? 'connected' : 'error'));
    })();
  </script>
</body>
</html>`);
  }
}

/** The failure message can contain provider text; it must not become markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

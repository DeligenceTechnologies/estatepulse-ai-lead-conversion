import { Controller, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { CrmRegistry } from './crm-registry';
import { CrmWebhooksService } from './crm-webhooks.service';

/**
 * HubSpot's webhook target. Public, and authenticated by HubSpot's v3 request
 * signature over the exact bytes received — never by a session, and never by
 * anything a caller could choose (no organization id, no token in the path).
 *
 * Status codes are load-bearing: HubSpot retries any non-2xx.
 *  - 200 once the delivery is queued, or deliberately dropped;
 *  - 401 for a signature that does not verify;
 *  - 400 for a body that is not a HubSpot delivery;
 *  - 503 when the delivery could not be stored, the one case a retry helps.
 */
@Public()
@Controller('ingest/v1/crm')
export class CrmWebhooksController {
  private readonly logger = new Logger('CrmWebhooks');

  constructor(
    private readonly registry: CrmRegistry,
    private readonly webhooks: CrmWebhooksService,
  ) {}

  @Post('hubspot/webhook')
  async hubspot(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    const hubspot = this.registry.byProvider('HUBSPOT');
    if (!hubspot || !this.registry.enabled(hubspot)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // The signature covers these exact bytes; re-serialised JSON would not match.
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let result;
    try {
      result = await this.webhooks.ingestHubSpot({
        method: req.method,
        url: req.originalUrl,
        rawBody,
        headers: req.headers as Record<string, unknown>,
      });
    } catch (err) {
      this.logger.error(`HubSpot webhook could not be stored: ${(err as Error).message}`);
      res.status(503).set('Retry-After', '60').json({ error: 'temporarily_unavailable' });
      return;
    }

    switch (result.kind) {
      case 'accepted':
        res.status(200).json({ received: true, accepted: result.accepted, duplicates: result.duplicates, ignored: result.ignored });
        return;
      case 'unauthenticated':
        res.status(401).json({ error: 'invalid_signature' });
        return;
      case 'invalid_payload':
        res.status(400).json({ error: 'invalid_payload' });
        return;
    }
  }
}

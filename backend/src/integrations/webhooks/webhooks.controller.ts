import { Controller, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { NANGO_WEBHOOK_ROUTE } from '../integrations.constants';
import { NangoWebhooksService } from './webhooks.service';

/**
 * Nango's webhook target: POST /webhooks/nango, outside /api (root-routes.ts),
 * so the URL in the Nango dashboard never changes with the app's prefix.
 * Public, authenticated only by Nango's HMAC over the exact bytes received.
 *
 * Nango retries anything not 2xx:
 *  - 200 processed, ignored, or a duplicate;
 *  - 400 bad signature or body (never processed);
 *  - 500 processing failed (retried);
 *  - 503 webhooks are not configured on this server.
 */
@Public()
@Controller(NANGO_WEBHOOK_ROUTE)
export class NangoWebhooksController {
  private readonly logger = new Logger('NangoWebhook');

  constructor(private readonly webhooks: NangoWebhooksService) {}

  @Post()
  async receive(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let result;
    try {
      result = await this.webhooks.receive(rawBody, req.headers as Record<string, unknown>);
    } catch (error) {
      this.logger.error(`Nango webhook could not be processed: ${(error as Error).message}`);
      res.status(503).set('Retry-After', '60').json({ error: 'temporarily_unavailable' });
      return;
    }

    switch (result.kind) {
      case 'processed':
      case 'ignored':
      case 'duplicate':
        res.status(200).json({ received: true, status: result.kind });
        return;
      case 'invalid_signature':
        this.logger.warn('Refused a Nango webhook with an invalid signature');
        res.status(400).json({ error: 'invalid_signature' });
        return;
      case 'invalid_body':
        res.status(400).json({ error: 'invalid_body' });
        return;
      case 'failed':
        res.status(500).json({ error: 'processing_failed' });
        return;
      case 'not_configured':
        res.status(503).json({ error: 'not_configured' });
        return;
    }
  }
}

import { Controller, HttpCode, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { NangoWebhookService } from './nango-webhook.service';

/**
 * Nango's webhook target: POST /webhooks/nango, outside /api (root-routes.ts),
 * so the URL set in the Nango dashboard never changes with the app's prefix.
 * Public, and authenticated only by Nango's HMAC over the exact bytes received
 * (req.rawBody; see rawBody in server.ts).
 *
 * Nango retries anything not 2xx, so: 200 accepted, ignored or a duplicate;
 * 400 bad signature or body; 503 not configured or the event could not be
 * stored or queued (retried).
 */
@Public()
@Controller('webhooks')
export class NangoWebhookController {
  private readonly logger = new Logger('NangoWebhook');

  constructor(private readonly webhooks: NangoWebhookService) {}

  @Post('nango')
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let result;
    try {
      result = await this.webhooks.receive(rawBody, req.headers);
    } catch (error) {
      this.logger.error(`Nango webhook could not be stored or queued: ${(error as Error).message}`);
      res.status(503).set('Retry-After', '60').json({ error: 'temporarily_unavailable' });
      return;
    }

    switch (result) {
      case 'invalid_signature':
        this.logger.warn('Refused a Nango webhook with an invalid signature');
        res.status(400).json({ error: 'invalid_signature' });
        return;
      case 'invalid_payload':
        res.status(400).json({ error: 'invalid_payload' });
        return;
      case 'not_configured':
        res.status(503).json({ error: 'not_configured' });
        return;
      default:
        res.status(200).json({ received: true, status: result });
    }
  }
}

import { Controller, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { StripeWebhookService } from './services/stripe-webhook.service';

/**
 * Stripe's webhook target: POST /billing/webhook, outside /api (root-routes.ts),
 * so the URL registered in the Stripe Dashboard never changes with the app's
 * prefix. Public, and authenticated only by Stripe's signature over the exact
 * bytes received (Nest keeps them as req.rawBody; see rawBody in server.ts).
 *
 * Status codes are what Stripe acts on — it retries anything not 2xx:
 *  - 200 processed, ignored, or a duplicate of one already done;
 *  - 400 a signature that does not verify (or no body);
 *  - 409 the same event is being processed right now — come back later;
 *  - 500 processing failed; the event is kept as failed and retried;
 *  - 503 billing is not configured, or the event could not be stored.
 */
@Public()
@Controller('billing')
export class BillingWebhookController {
  private readonly logger = new Logger('BillingWebhook');

  constructor(private readonly webhooks: StripeWebhookService) {}

  @Post('webhook')
  async receive(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }
    const signature = req.headers['stripe-signature'];

    let result;
    try {
      result = await this.webhooks.receive(rawBody, typeof signature === 'string' ? signature : undefined);
    } catch (error) {
      this.logger.error(`Stripe webhook could not be stored: ${(error as Error).message}`);
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
        res.status(400).json({ error: 'invalid_signature' });
        return;
      case 'in_progress':
        res.status(409).json({ error: 'in_progress' });
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

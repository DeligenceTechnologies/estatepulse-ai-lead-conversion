import { Controller, HttpStatus, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { StripeWebhookService, WebhookResultKind, type WebhookResult } from './services/stripe-webhook.service';

const RESPONSE: Readonly<Record<WebhookResultKind, [HttpStatus, Record<string, unknown>]>> = {
  [WebhookResultKind.PROCESSED]: [HttpStatus.OK, { received: true, status: WebhookResultKind.PROCESSED }],
  [WebhookResultKind.IGNORED]: [HttpStatus.OK, { received: true, status: WebhookResultKind.IGNORED }],
  [WebhookResultKind.DUPLICATE]: [HttpStatus.OK, { received: true, status: WebhookResultKind.DUPLICATE }],
  [WebhookResultKind.INVALID_SIGNATURE]: [HttpStatus.BAD_REQUEST, { error: 'invalid_signature' }],
  [WebhookResultKind.IN_PROGRESS]: [HttpStatus.CONFLICT, { error: 'in_progress' }],
  [WebhookResultKind.FAILED]: [HttpStatus.INTERNAL_SERVER_ERROR, { error: 'processing_failed' }],
  [WebhookResultKind.NOT_CONFIGURED]: [HttpStatus.SERVICE_UNAVAILABLE, { error: 'not_configured' }],
};

/** POST /billing/webhook (outside /api). Authenticated by Stripe signature over req.rawBody; non-2xx makes Stripe retry. */
@Public()
@Controller('billing')
export class BillingWebhookController {
  private readonly logger = new Logger('BillingWebhook');

  constructor(private readonly webhooks: StripeWebhookService) {}

  @Post('webhook')
  async receive(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'empty_body' });
      return;
    }
    const signature = req.headers['stripe-signature'];

    let result: WebhookResult;
    try {
      result = await this.webhooks.receive(rawBody, typeof signature === 'string' ? signature : undefined);
    } catch (error) {
      this.logger.error(`Stripe webhook could not be stored: ${(error as Error).message}`);
      res.status(HttpStatus.SERVICE_UNAVAILABLE).set('Retry-After', '60').json({ error: 'temporarily_unavailable' });
      return;
    }
    const [status, body] = RESPONSE[result.kind];
    res.status(status).json(body);
  }
}

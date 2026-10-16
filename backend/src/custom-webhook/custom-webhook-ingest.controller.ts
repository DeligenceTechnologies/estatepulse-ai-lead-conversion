import { Controller, Logger, Param, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import type { IntegrationEnv } from '@/common/utils/interface';
import { ProcessingWorker } from '@/ingest/processing/worker.service';
import { customWebhookEnabled } from './custom-webhook-enabled.guard';
import { CustomWebhookIngestService, type CustomIngestResult } from './custom-webhook-ingest.service';

/**
 * The public URL an owner pastes into any app. The token in the path is the
 * credential; the source's own auth mode (none, shared header, HMAC, basic) is
 * checked on top of it.
 *
 * Status codes are load-bearing, as on the form routes: a sender retries on
 * non-2xx, so a payload we could not use (400/401/415) must not read like a
 * failure of ours (503), and a dropped delivery is acknowledged with a 2xx so a
 * forgotten setup does not turn into a month of retries.
 */
@Public()
@Controller('ingest/v1')
export class CustomWebhookIngestController {
  private readonly logger = new Logger(CustomWebhookIngestController.name);

  constructor(
    private readonly ingest: CustomWebhookIngestService,
    private readonly worker: ProcessingWorker,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  @Post('custom/:token')
  async receive(@Param('token') token: string, @Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    // Off = the route does not exist, exactly as an unknown token reads.
    if (!customWebhookEnabled(this.config)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Only the two body types the parsers decode; anything else arrived as
    // bytes nobody read (and no rawBody), which would silently map to nothing.
    const hasBody = typeof req.headers['content-length'] === 'string' ? req.headers['content-length'] !== '0' : true;
    if (hasBody && !req.is('application/json') && !req.is('application/x-www-form-urlencoded')) {
      res.status(415).json({ error: 'unsupported_content_type' });
      return;
    }
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let result: CustomIngestResult;
    try {
      result = await this.ingest.receive({ token, rawBody, body: req.body as unknown, headers: req.headers });
    } catch (error) {
      // We failed to durably store the bytes: the sender's retry buffer is the
      // only copy, so ask for one.
      this.logger.error(`Custom ingest failed to persist: ${(error as Error).message}`);
      res.status(503).set('Retry-After', '300').json({ error: 'temporarily_unavailable' });
      return;
    }

    switch (result.kind) {
      case 'accepted':
        res.status(202).json({ received: true, deliveryId: result.eventId });
        this.worker.nudge();
        return;
      case 'duplicate':
        res.status(200).json({ received: true, duplicate: true, deliveryId: result.eventId });
        return;
      case 'held':
        // Stored, waiting for the owner (mapping, or a pause). Nothing for the
        // sender to do; it must not retry.
        res.status(202).json({ received: true, held: true, reason: result.reason, deliveryId: result.eventId });
        return;
      case 'dropped':
        res.status(202).json({ received: false, dropped: true, reason: result.reason });
        return;
      case 'quarantined':
        res.status(401).json({ error: result.reason, deliveryId: result.eventId });
        return;
      case 'invalid_payload':
        res.status(400).json({ error: 'invalid_payload', detail: result.detail, deliveryId: result.eventId });
        return;
      case 'archived':
        res.status(410).json({ error: 'source_archived' });
        return;
      case 'unknown_token':
        res.status(404).json({ error: 'not_found' });
        return;
    }
  }
}

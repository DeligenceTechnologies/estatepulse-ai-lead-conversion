import { Controller, Headers, Logger, Param, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { IngestService, type IngestRoute } from './ingest.service';
import { ProcessingWorker } from './processing/worker.service';

/**
 * Public endpoints form providers post to. The token in the path is the only
 * credential; the response says as little as possible about why a delivery
 * was refused, and a storage failure asks the provider to retry later.
 */
@Public()
@Controller()
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly ingest: IngestService,
    private readonly worker: ProcessingWorker,
  ) {}

  @Post('ingest/v1/tally/:token')
  tally(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('tally-signature') signature?: string,
  ) {
    return this.handle('TALLY', token, req, res, signature);
  }

  @Post('ingest/v1/typeform/:token')
  typeform(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('typeform-signature') signature?: string,
  ) {
    return this.handle('TYPEFORM', token, req, res, signature);
  }

  @Post(['ingest/v1/webhook/:token', 'webhooks/leads/:token'])
  webhook(@Param('token') token: string, @Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.handle('WEBHOOK', token, req, res, undefined);
  }

  private async handle(
    route: IngestRoute,
    token: string,
    req: RawBodyRequest<Request>,
    res: Response,
    signature: string | undefined,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody?.byteLength) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let result;
    try {
      result = await this.ingest.receive({ route, token, rawBody, headers: req.headers, signature });
    } catch (error) {
      this.logger.error(`Ingest failed to persist: ${(error as Error).message}`);
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
        res.status(202).json({ received: true, paused: true, deliveryId: result.eventId });
        return;
      case 'invalid_payload':
        res.status(400).json({ error: 'invalid_payload', deliveryId: result.eventId });
        return;
      case 'quarantined':
        res.status(401).json({ error: result.reason, deliveryId: result.eventId });
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

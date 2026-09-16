import { Controller, Headers, Ip, Logger, Param, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProcessingWorker } from '../processing/worker.service';
import { IngestService } from './ingest.service';

/**
 * Public webhook endpoint. Deliberately NOT under /v1 and NOT authenticated with
 * an API key — the ingest token in the path is the credential.
 *
 * Status codes here are load-bearing. Tally retries non-2xx at
 * 5min → 30min → 1hr → 6hr → 1day and then emails the form owner that our
 * webhook is failing, so returning the wrong code for an error WE caused
 * generates duplicate deliveries and an upstream reputation hit.
 */
@Controller('ingest/v1')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly ingest: IngestService,
    private readonly worker: ProcessingWorker,
  ) {}

  @Post('tally/:token')
  async tally(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('tally-signature') signature: string | undefined,
    @Ip() ip: string,
  ): Promise<void> {
    const startedAt = Date.now();

    // rawBody is populated by `NestFactory.create(..., { rawBody: true })`.
    // Without it there is nothing to verify the HMAC against.
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let result;
    try {
      result = await this.ingest.ingestTally({
        token,
        rawBody,
        headers: req.headers as Record<string, unknown>,
        signature,
        sourceIp: ip,
      });
    } catch (err) {
      // The ONE case where we actively want Tally to retry: we failed to durably
      // store the payload, so its only remaining copy is in their retry buffer.
      //
      // 503 rather than 500 — 500 reads as "permanently broken", 503 as "come
      // back". Retry-After aligns with Tally's first rung so the retry is not
      // wasted. Note this also means signature verification must never fail
      // open: a DB error here returns 503 rather than falling through to
      // "no secret found, therefore accept".
      this.logger.error(`Ingest failed to persist: ${String(err)}`);
      res.status(503).set('Retry-After', '300').json({ error: 'temporarily_unavailable' });
      return;
    }

    const ms = Date.now() - startedAt;
    if (ms > 1000) {
      // The 10s cliff is real; alert well before it.
      this.logger.warn(`Slow ingest: ${ms}ms (token ${token.slice(0, 12)}…)`);
    }

    switch (result.kind) {
      case 'accepted':
        // 202: accepted for asynchronous processing, which is literally what
        // happened. Respond FIRST, then nudge the worker — the nudge is an
        // optimisation (it usually makes processing land in ~20ms instead of
        // waiting for the next 1s poll) and must never delay the response or
        // push us toward the provider's 10s timeout.
        res.status(202).json({ received: true, deliveryId: result.eventId });
        this.worker.nudge();
        return;

      case 'duplicate':
        // 200, silently successful. This is the critical one: a 409 or 5xx here
        // means Tally retries for a day over a delivery we already hold, and
        // then tells the brokerage our webhook is broken. Idempotency must be
        // invisible.
        res.status(200).json({ received: true, duplicate: true, deliveryId: result.eventId });
        return;

      case 'held':
        // The source is paused. Their form is fine; this is our state. Stored
        // and queued behind a far-future availableAt, drains on resume.
        res.status(202).json({ received: true, paused: true, deliveryId: result.eventId });
        return;

      case 'invalid_payload':
        // Retrying cannot fix a malformed body, and 400 is honest.
        res.status(400).json({ error: 'invalid_payload', deliveryId: result.eventId });
        return;

      case 'quarantined':
        // Body retained for re-verification once the secret is corrected.
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

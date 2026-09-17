import { Body, Controller, HttpStatus, Logger, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PortalIngestService, type IngestOutcome } from './portal-ingest.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Turns an ingest outcome into a response.
 *
 * Status codes are load-bearing: a provider retries on non-2xx, so "we could
 * not use this payload" (400) must never be reported the same way as "we broke"
 * (503), or a permanently-bad submission retries forever.
 *
 * A module-level function rather than a base class, because both controllers
 * below need it and a controller cannot be injected into another controller.
 */
async function respond(
  ingest: PortalIngestService,
  logger: Logger,
  provider: string,
  token: string,
  body: any,
  res: Response,
): Promise<void> {
  if (!token) {
    res
      .status(HttpStatus.BAD_REQUEST)
      .json({ error: { code: 'VALIDATION_ERROR', message: 'Ingest token required' } });
    return;
  }

  let out: IngestOutcome;
  try {
    out = await ingest.ingestLead(token, provider, body);
  } catch (e) {
    logger.error(`handler: ${(e as Error).message}`);
    res
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json({ error: { code: 'INTERNAL', message: 'Could not process submission' } });
    return;
  }

  switch (out.kind) {
    case 'accepted':
      res.status(HttpStatus.ACCEPTED).json({ received: true, leadId: out.leadId });
      return;
    case 'duplicate':
      res.status(HttpStatus.OK).json({ received: true, duplicate: true, leadId: out.leadId });
      return;
    case 'invalid':
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'No phone or email in payload' } });
      return;
    case 'unknown_token':
      res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: { code: 'NOT_FOUND', message: 'Ingest token not recognized' } });
      return;
    case 'inactive':
      res
        .status(HttpStatus.GONE)
        .json({ error: { code: 'CONFLICT', message: 'This ingest source is disabled' } });
      return;
  }
}

/**
 * Public (unauthenticated) lead-ingestion webhook. Identity comes from the token
 * in the URL — never a session — so there is no guard here.
 */
@Controller('api/ingest/v1')
export class PortalIngestController {
  private readonly logger = new Logger('PortalIngest');

  constructor(private readonly ingest: PortalIngestService) {}

  @Post('tally/:token')
  tally(@Param('token') token: string, @Body() body: any, @Res() res: Response): Promise<void> {
    return respond(this.ingest, this.logger, 'tally', token, body, res);
  }

  @Post('webhook/:token')
  webhook(@Param('token') token: string, @Body() body: any, @Res() res: Response): Promise<void> {
    return respond(this.ingest, this.logger, 'webhook', token, body, res);
  }
}

/** Alias for the Milestone-1 doc's path: POST /api/webhooks/leads/:token */
@Controller('api/webhooks/leads')
export class PortalIngestAliasController {
  private readonly logger = new Logger('PortalIngest');

  constructor(private readonly ingest: PortalIngestService) {}

  @Post(':token')
  post(@Param('token') token: string, @Body() body: any, @Res() res: Response): Promise<void> {
    return respond(this.ingest, this.logger, 'webhook', token, body, res);
  }
}

import { Controller, Headers, Logger, Param, Post, Req, Res, UseInterceptors, type RawBodyRequest } from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import type { IntegrationEnv } from '@/common/utils/interface';
import { GOOGLE_FORMS_SIGNATURE_HEADER } from '@/google-forms/constants';
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
    private readonly config: ConfigService<IntegrationEnv, true>,
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

  /**
   * Jotform posts each submission as multipart form fields, which the global
   * body parsers do not read, so there is no raw body to store. Multer reads
   * the fields here, and the parts that matter are stored as JSON instead:
   * the same bytes then feed the payload hash, the stored delivery and the
   * adapter. Jotform signs nothing; the token in the path is the credential.
   * A urlencoded or JSON post with the same fields works too.
   */
  @Post('ingest/v1/jotform/:token')
  // A submission is a few dozen short fields; the caps keep an oversized post
  // to this public URL from being read into memory at all.
  @UseInterceptors(NoFilesInterceptor({ limits: { fields: 300, fieldSize: 1024 * 1024, parts: 300 } }))
  jotform(@Param('token') token: string, @Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let rawBody = req.rawBody;
    if (body.rawRequest !== undefined) {
      let rawRequest: unknown = body.rawRequest;
      if (typeof rawRequest === 'string') {
        try {
          rawRequest = JSON.parse(rawRequest);
        } catch {
          // Left as a string; the adapter records it as an invalid payload.
        }
      }
      rawBody = Buffer.from(
        JSON.stringify({
          submissionID: body.submissionID ?? null,
          formID: body.formID ?? null,
          formTitle: body.formTitle ?? null,
          rawRequest,
        }),
      );
    }
    return this.handle('JOTFORM', token, req, res, undefined, rawBody);
  }

  /**
   * Where the Apps Script on an owner's Google Form posts each response. The
   * script is an external client like any other provider: the token in the
   * path and the HMAC over the body are the whole credential, and switching
   * the feature off makes the route answer 404 exactly as an unknown token
   * does, so nothing leaks about whether it exists.
   */
  @Post('ingest/v1/google-forms/:token')
  googleForms(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers(GOOGLE_FORMS_SIGNATURE_HEADER) signature?: string,
  ) {
    if (!this.config.get('GOOGLE_FORMS_ENABLED', { infer: true })) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    return this.handle('GOOGLE_FORMS', token, req, res, signature);
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
    rawBody: Buffer | undefined = req.rawBody,
  ): Promise<void> {
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

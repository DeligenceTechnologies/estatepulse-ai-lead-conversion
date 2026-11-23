import { Controller, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { AirtableConnectionsService } from './airtable-connections.service';
import { AirtableSyncService } from './airtable-sync.service';

/**
 * Airtable's notification target. Public, and authenticated by Airtable's
 * `X-Airtable-Content-MAC` over the exact bytes received — never by a session,
 * and never by anything a caller could choose.
 *
 * Airtable's notification is only a PING: it names the base and the webhook and
 * carries no changes. So nothing is parsed out of it and nothing is trusted
 * from it; a verified ping only wakes the sync, which then fetches the changes
 * itself over an authenticated connection. That also makes a replayed ping
 * harmless.
 *
 * Status codes are load-bearing: Airtable retries a non-2xx up to 13 times and
 * then disables notifications for the webhook.
 *  - 200 once the sync has been woken, or the ping deliberately dropped;
 *  - 401 for a MAC that does not verify;
 *  - 400 for a body that is not an Airtable ping.
 */
@Public()
@Controller('ingest/v1/airtable')
export class AirtableWebhooksController {
  private readonly logger = new Logger('AirtableWebhooks');

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: AirtableConnectionsService,
    private readonly sync: AirtableSyncService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  @Post('webhook')
  async notify(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    if (!this.config.get('AIRTABLE_ENABLED', { infer: true })) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // The MAC covers these exact bytes; re-serialised JSON would not match.
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.byteLength === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    let ping: { base?: { id?: string }; webhook?: { id?: string } };
    try {
      ping = JSON.parse(rawBody.toString('utf8')) as typeof ping;
    } catch {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const webhookId = ping.webhook?.id;
    const baseId = ping.base?.id;
    if (!webhookId || !baseId) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    // Which source this is for. An unknown webhook id is answered 200 and
    // dropped: retrying it would never help, and saying "unknown" would tell a
    // caller which ids exist.
    const source = await this.prisma.leadSource.findFirst({
      where: { provider: 'AIRTABLE', externalWebhookId: webhookId, archivedAt: null },
      select: { id: true, orgId: true, signingSecretEnc: true, externalFormId: true },
    });
    if (!source || !source.externalFormId?.startsWith(`${baseId}:`)) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    const secret = this.connections.openForSource(source.orgId, source.id, source.signingSecretEnc);
    if (!secret || !verifyMac(rawBody, secret, req.headers['x-airtable-content-mac'])) {
      this.logger.warn(`Airtable ping for webhook ${webhookId} failed signature verification`);
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    // Deliberately nothing from the body is written. The ping only says
    // "something changed"; the sync reads what, over its own connection.
    await this.prisma.leadSource.updateMany({ where: { id: source.id, orgId: source.orgId }, data: { lastEventAt: new Date(), syncNextAt: new Date() } });
    this.sync.nudge();
    res.status(200).json({ received: true });
  }
}

/**
 * Airtable signs with HMAC-SHA256 keyed by the base64-DECODED macSecretBase64,
 * and sends it as `hmac-sha256=<hex>`.
 */
export function verifyMac(rawBody: Buffer, macSecretBase64: string, header: unknown): boolean {
  if (typeof header !== 'string' || !header) return false;
  const expected = `hmac-sha256=${createHmac('sha256', Buffer.from(macSecretBase64, 'base64')).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { NangoAuthWebhookBody, NangoSyncWebhookBody } from '@nangohq/node';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/service/redis.service';
import { sha256Hex } from '@/common/utils/crypto';
import { ConnectionsService } from '../connections/connections.service';
import { WEBHOOK_DEDUPE_TTL_SECONDS } from '../integrations.constants';
import { NangoService } from '../nango/nango.service';
import { ProvidersService } from '../providers/providers.service';
import { SyncService } from '../sync/sync.service';

export type WebhookResult =
  | { kind: 'processed' | 'ignored' | 'duplicate' }
  | { kind: 'invalid_signature' | 'invalid_body' | 'not_configured' | 'failed' };

interface WebhookBase {
  type?: unknown;
  from?: unknown;
}

/**
 * Nango's webhooks. Nothing in a payload is trusted until its HMAC verifies
 * against NANGO_WEBHOOK_SIGNING_KEY. Even then, the organization is never read
 * from the payload for an existing connection: it comes from our own row
 * (looked up by Nango connection id). For a new connection (`creation`) it
 * comes from the tags this server wrote on the connect session, re-read from
 * Nango's API rather than from the webhook body.
 *
 * Redeliveries are recognised by the hash of the exact body and processed once.
 */
@Injectable()
export class NangoWebhooksService {
  private readonly logger = new Logger('NangoWebhook');

  constructor(
    private readonly nango: NangoService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly providers: ProvidersService,
    private readonly sync: SyncService,
  ) {}

  async receive(rawBody: Buffer, headers: Record<string, unknown>): Promise<WebhookResult> {
    if (!this.nango.webhooksConfigured) return { kind: 'not_configured' };
    const text = rawBody.toString('utf8');
    if (!this.nango.verifyWebhook(text, headers)) return { kind: 'invalid_signature' };

    let body: WebhookBase;
    try {
      body = JSON.parse(text) as WebhookBase;
    } catch {
      return { kind: 'invalid_body' };
    }
    if (!body || typeof body !== 'object') return { kind: 'invalid_body' };

    const key = `nango-webhook:${sha256Hex(text).slice(0, 48)}`;
    const fresh = await this.claim(key);
    if (!fresh) return { kind: 'duplicate' };

    try {
      const handled = await this.dispatch(body);
      return { kind: handled ? 'processed' : 'ignored' };
    } catch (error) {
      // Let Nango retry: forget the delivery so the retry is processed.
      await this.redis.client.del(key).catch(() => undefined);
      this.logger.error(`Nango ${String(body.type)} webhook failed: ${(error as Error).message}`);
      return { kind: 'failed' };
    }
  }

  private async dispatch(body: WebhookBase): Promise<boolean> {
    switch (body.type) {
      case 'auth':
        return this.onAuth(body as unknown as NangoAuthWebhookBody);
      case 'sync':
        return this.onSync(body as unknown as NangoSyncWebhookBody);
      default:
        // forward / async_action: EstatePulse does not use them yet.
        return false;
    }
  }

  private async onAuth(body: NangoAuthWebhookBody): Promise<boolean> {
    const { connectionId, providerConfigKey, operation } = body;
    if (typeof connectionId !== 'string' || typeof providerConfigKey !== 'string') return false;
    if (!(await this.providers.integrationByKey(providerConfigKey))) return false;

    switch (operation) {
      case 'creation':
      case 'override': {
        // A failed attempt: the person saw the error in Connect UI; nothing was created.
        if (!body.success) return false;
        try {
          await this.connections.linkFromWebhook(providerConfigKey, connectionId);
        } catch (error) {
          // Not ours (not tagged for an organization) or already gone: nothing to retry.
          if (error instanceof HttpException && error.getStatus() < 500) {
            this.logger.warn(`Ignored ${operation} of ${providerConfigKey} connection ${connectionId}: ${error.message}`);
            return false;
          }
          throw error;
        }
        return true;
      }
      case 'refresh':
        if (body.success) await this.connections.markHealthy(connectionId);
        else await this.connections.markReauthRequired(connectionId, 'The provider stopped accepting this connection (token refresh failed). Reconnect to continue.');
        return true;
      case 'deletion':
        await this.connections.markDeletedRemotely(connectionId);
        return true;
      default:
        return false;
    }
  }

  /**
   * A Nango-side sync finished. EstatePulse imports through its own queue, so a
   * successful sync that changed records triggers one (de-duplicated: a sync
   * already queued or running absorbs it).
   */
  private async onSync(body: NangoSyncWebhookBody): Promise<boolean> {
    if (typeof body.connectionId !== 'string') return false;
    const row = await this.prisma.integrationConnection.findUnique({
      where: { nangoConnectionId: body.connectionId },
      select: { id: true, orgId: true, provider: true, providerConfigKey: true, status: true, settings: true },
    });
    if (!row || row.providerConfigKey !== body.providerConfigKey) return false;
    if (!body.success) {
      this.logger.warn(`Nango sync "${body.syncName}" failed for connection ${row.id}`);
      return true;
    }
    const changed = (body.responseResults?.added ?? 0) + (body.responseResults?.updated ?? 0);
    if (changed === 0 || this.sync.blocker(row)) return true;
    await this.sync.enqueue(row.orgId, row.id, 'webhook', null);
    return true;
  }

  /** True the first time this delivery is seen. */
  private async claim(key: string): Promise<boolean> {
    const set = await this.redis.client.set(key, '1', 'EX', WEBHOOK_DEDUPE_TTL_SECONDS, 'NX');
    return set === 'OK';
  }
}

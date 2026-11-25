import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectionAlertService } from '@/common/service/connection-alert.service';
import { ConnectionsService } from '@/connections/connections.service';
import { NangoError } from '@/nango/nango.service';
import { PROVIDER_LABEL } from '../calendar.types';
import { ProviderHttpError } from '../providers/provider-http';
import { SchedulingProvider } from '../providers/scheduling-provider';
import { inUse } from './connection-state';

export const CALENDAR_UNAVAILABLE = 'Calendar connections are not available yet. Please contact support.';

/** The columns needed to call the provider on a connection's behalf. */
export const USAGE_FIELDS = {
  id: true,
  orgId: true,
  provider: true,
  status: true,
  workspaceType: true,
  workspaceId: true,
  workspaceSlug: true,
  accountId: true,
  integrationId: true,
  integration: { select: { id: true, provider: true, nangoConnectionId: true } },
  lastError: true,
  webhookId: true,
  scope: true,
} as const satisfies Prisma.CalendarConnectionSelect;

export type UsableConnection = Prisma.CalendarConnectionGetPayload<{ select: typeof USAGE_FIELDS }>;

/** What a connection the provider stopped accepting says until it is reconnected. */
export function rejectedMessage(provider: UsableConnection['provider']): string {
  const label = PROVIDER_LABEL[provider];
  return `${label} no longer accepts this connection. Reconnect ${label} to continue.`;
}

/** Someone reconnected while this request held the old credentials. */
class CredentialsChanged extends Error {}

/**
 * The one gate to a connection's credentials. Everything that calls Calendly
 * or Cal.com for an organization goes through here, so reading credentials
 * and parking a connection the provider has stopped accepting happen in
 * exactly one place. The credential is the linked integration's, held by
 * Nango (ConnectionsService): Calendly's OAuth grant or Cal.com's API key.
 */
@Injectable()
export class CalendarAccessService {
  private readonly logger = new Logger(CalendarAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: SchedulingProvider,
    private readonly connectionAlerts: ConnectionAlertService,
    private readonly connections: ConnectionsService,
  ) {}

  /**
   * Runs `run` with the organization's connection in use and a working secret.
   * Retries once if the connection was replaced mid-call.
   */
  async useActive<T>(orgId: string, run: (connection: UsableConnection, secret: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const connection = await this.prisma.calendarConnection.findFirst({
        where: inUse(orgId),
        select: USAGE_FIELDS,
      });
      if (!connection) {
        throw new NotFoundException('No calendar is connected.');
      }
      if (connection.status === 'error') {
        throw new ConflictException(
          connection.lastError ?? `${PROVIDER_LABEL[connection.provider]} needs to be reconnected.`,
        );
      }

      try {
        return await this.withCredentials(orgId, connection, (secret) => run(connection, secret));
      } catch (error) {
        if (!(error instanceof CredentialsChanged)) throw error;
        if (attempt > 0) throw new ConflictException(error.message);
      }
    }
  }

  /** Proves a stored (possibly inactive) connection still works before it is switched on. */
  async verify(orgId: string, connection: UsableConnection): Promise<void> {
    try {
      await this.withCredentials(orgId, connection, (secret) => this.provider.verify(connection.provider, secret));
    } catch (error) {
      if (error instanceof CredentialsChanged) throw new ConflictException(error.message);
      throw error;
    }
  }

  /** Best effort: a webhook left behind only costs the provider a failed delivery. */
  async removeWebhook(connection: UsableConnection): Promise<void> {
    if (!connection.webhookId || connection.status !== 'active') return;
    try {
      const secret = await this.secretFor(connection, false);
      await this.provider.deleteWebhook(connection.provider, secret, connection.webhookId);
    } catch (error) {
      this.logger.warn(`${PROVIDER_LABEL[connection.provider]} webhook removal failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parks the connection the provider stopped accepting, so every screen shows
   * "reconnect" instead of failing call after call. A saved (inactive) one
   * keeps its status and only records the error. Matching on the integration
   * and status read earlier keeps a reconnect or a switch that happened
   * meanwhile from being overwritten. Returns the message to show.
   */
  async park(orgId: string, connection: Pick<UsableConnection, 'id' | 'provider' | 'status' | 'integrationId'>): Promise<{ parked: boolean; message: string }> {
    const label = PROVIDER_LABEL[connection.provider];
    const message = rejectedMessage(connection.provider);
    const parked = await this.prisma.calendarConnection.updateMany({
      where: {
        id: connection.id,
        orgId,
        integrationId: connection.integrationId,
        status: connection.status,
      },
      data: connection.status === 'active' ? { status: 'error', lastError: message } : { lastError: message },
    });
    // Only the connection in use breaking pauses anything; a saved one just records it.
    if (parked.count > 0 && connection.status === 'active') {
      this.connectionAlerts.connectionBroken({
        orgId,
        connectionId: connection.id,
        providerLabel: label,
        impact: 'Leads cannot book meetings, and availability and meetings are not syncing.',
        reconnectPath: '/integrations',
        brokenAt: new Date(),
      });
    }
    return { parked: parked.count > 0, message };
  }

  private async withCredentials<T>(
    orgId: string,
    connection: UsableConnection,
    run: (secret: string) => Promise<T>,
  ): Promise<T> {
    try {
      try {
        return await run(await this.secretFor(connection, false));
      } catch (error) {
        // Calendly: the token may have been revoked early; ask Nango for a new one once.
        if (!(connection.provider === 'calendly' && error instanceof ProviderHttpError && error.credentialRejected)) throw error;
        return await run(await this.secretFor(connection, true));
      }
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      if (!error.credentialRejected) throw new BadGatewayException(error.message);
      const { parked, message } = await this.park(orgId, connection);
      if (!parked) throw new CredentialsChanged(message);
      throw new ConflictException(message);
    }
  }

  /** The provider credential, from Nango: Calendly's OAuth token or Cal.com's API key. */
  private async secretFor(connection: UsableConnection, forceRefresh: boolean): Promise<string> {
    const label = PROVIDER_LABEL[connection.provider];
    try {
      return await this.connections.credential(connection.integration, forceRefresh);
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') throw new ProviderHttpError(label, 401, error.message);
      if (error instanceof NangoError) throw new ProviderHttpError(label, error.kind === 'UNAVAILABLE' ? 503 : 500, error.message);
      throw error;
    }
  }
}

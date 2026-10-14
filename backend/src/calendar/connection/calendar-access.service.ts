import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { PROVIDER_LABEL, type CalCredentials, type CalendlyCredentials } from '../calendar.types';
import { CalendlyClient, type CalendlyGrant } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import { SchedulingProvider } from '../providers/scheduling-provider';
import { inUse } from './connection-state';

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

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
  credentials: true,
  tokenExpiresAt: true,
  lastError: true,
  webhookId: true,
} as const satisfies Prisma.CalendarConnectionSelect;

export type UsableConnection = Prisma.CalendarConnectionGetPayload<{ select: typeof USAGE_FIELDS }>;

/** Someone reconnected while this request held the old credentials. */
class CredentialsChanged extends Error {}

/**
 * The one gate to a connection's credentials. Everything that calls Calendly
 * or Cal.com for an organization goes through here, so decrypting, refreshing
 * Calendly tokens and parking a connection the provider has stopped accepting
 * happen in exactly one place.
 */
@Injectable()
export class CalendarAccessService {
  private readonly logger = new Logger(CalendarAccessService.name);
  /** In-flight Calendly refreshes per connection, so concurrent calls share one. */
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly calendly: CalendlyClient,
    private readonly provider: SchedulingProvider,
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
      const secret = await this.secretFor(connection);
      await this.provider.deleteWebhook(connection.provider, secret, connection.webhookId);
    } catch (error) {
      this.logger.warn(`${PROVIDER_LABEL[connection.provider]} webhook removal failed: ${(error as Error).message}`);
    }
  }

  /** Best effort: revokes the Calendly grant stored in `sealed`, which we are about to forget. */
  async revokeStoredCalendly(sealed: string): Promise<void> {
    await this.revokeCalendly(this.unseal<CalendlyCredentials>(sealed)?.refreshToken);
  }

  /** Best effort: revokes a Calendly token we are about to forget. */
  async revokeCalendly(token: string | undefined): Promise<void> {
    if (!token || !this.calendly.configured) return;
    try {
      await this.calendly.revoke(token);
    } catch (error) {
      this.logger.warn(`Calendly token revocation failed: ${(error as Error).message}`);
    }
  }

  /** Decrypts a sealed JSON value; null when it cannot be read. */
  unseal<T>(sealed: string): T | null {
    if (!this.secrets.enabled) return null;
    try {
      return JSON.parse(this.secrets.open(sealed)) as T;
    } catch {
      return null;
    }
  }

  private async withCredentials<T>(
    orgId: string,
    connection: UsableConnection,
    run: (secret: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(await this.secretFor(connection));
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      if (!error.credentialRejected) throw new BadGatewayException(error.message);

      // The provider refused the credentials: park the connection so every
      // screen shows "reconnect" instead of failing call after call. A saved
      // (inactive) one keeps its status and only records the error. Matching
      // on the old credentials and status keeps a reconnect or a switch that
      // happened meanwhile from being overwritten.
      const label = PROVIDER_LABEL[connection.provider];
      const message = `${label} no longer accepts this connection. Reconnect ${label} to continue.`;
      const parked = await this.prisma.calendarConnection.updateMany({
        where: { id: connection.id, orgId, credentials: connection.credentials, status: connection.status },
        data: connection.status === 'active' ? { status: 'error', lastError: message } : { lastError: message },
      });
      if (parked.count === 0) throw new CredentialsChanged(message);
      throw new ConflictException(message);
    }
  }

  private async secretFor(connection: UsableConnection): Promise<string> {
    if (connection.provider === 'cal') {
      return this.requireCredentials<CalCredentials>(connection.credentials).apiKey;
    }

    const credentials = this.requireCredentials<CalendlyCredentials>(connection.credentials);
    const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
    if (expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return credentials.accessToken;
    }

    let pending = this.refreshes.get(connection.id);
    if (!pending) {
      pending = this.refreshCalendly(connection, credentials.refreshToken).finally(() =>
        this.refreshes.delete(connection.id),
      );
      this.refreshes.set(connection.id, pending);
    }
    return pending;
  }

  private async refreshCalendly(connection: UsableConnection, refreshToken: string): Promise<string> {
    let grant: CalendlyGrant;
    try {
      grant = await this.calendly.refresh(refreshToken);
    } catch (error) {
      // Calendly answers a dead refresh token with 400; treat it as a rejected credential.
      if (error instanceof ProviderHttpError && error.status === 400) {
        throw new ProviderHttpError(error.provider, 401, error.message);
      }
      throw error;
    }

    const credentials: CalendlyCredentials = { accessToken: grant.accessToken, refreshToken: grant.refreshToken };
    await this.prisma.calendarConnection.updateMany({
      where: { id: connection.id, credentials: connection.credentials },
      data: { credentials: this.secrets.seal(JSON.stringify(credentials)), tokenExpiresAt: grant.expiresAt },
    });
    return grant.accessToken;
  }

  private requireCredentials<T>(sealed: string): T {
    if (!this.secrets.enabled) {
      throw new ServiceUnavailableException(CALENDAR_UNAVAILABLE);
    }
    const credentials = this.unseal<T>(sealed);
    if (!credentials) {
      throw new ConflictException('The stored calendar credentials cannot be read. Reconnect the calendar.');
    }
    return credentials;
  }
}

/** Serializes connection changes per organization, so two connects cannot both end up active. */
export async function lockOrganization(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
}

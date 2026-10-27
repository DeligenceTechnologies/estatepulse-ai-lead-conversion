import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connectionBrokenEmail } from '@/common/mail/templates/connection-broken-email';
import { PrismaService } from '@/common/prisma/prisma.service';
import { MailService } from '@/common/service/mail.service';
import type { AppEnv } from '@/common/utils/interface';
import { EmailQueue } from '@/queue/email/email.queue';

export interface ConnectionBrokenEvent {
  orgId: string;
  /** The integration / calendar connection row; with `brokenAt`, makes the email once per break. */
  connectionId: string;
  providerLabel: string;
  account?: string | null;
  impact: string;
  /** App path the button opens, e.g. "/settings". */
  reconnectPath: string;
  brokenAt: Date;
}

/**
 * Emails the organization's active owners when a connection goes from working
 * to broken. Callers invoke it only on that transition, so a dead credential
 * hit many times alerts once. Fire-and-forget: never fails the caller.
 */
@Injectable()
export class ConnectionAlertService {
  private readonly logger = new Logger(ConnectionAlertService.name);
  private readonly appUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailQueue: EmailQueue,
    config: ConfigService<AppEnv, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true })?.replace(/\/+$/, '');
  }

  connectionBroken(event: ConnectionBrokenEvent): void {
    if (!this.mail.enabled) return;
    void this.send(event).catch((error) =>
      this.logger.error(`Could not queue the connection alert for ${event.connectionId}: ${(error as Error).message}`),
    );
  }

  private async send(event: ConnectionBrokenEvent): Promise<void> {
    const [org, owners] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: event.orgId }, select: { name: true } }),
      this.prisma.user.findMany({
        where: { orgId: event.orgId, status: 'active', roles: { some: { role: { isSystem: true } } } },
        select: { id: true, email: true, firstName: true },
      }),
    ]);
    if (!org || !owners.length) return;

    const reconnectUrl = this.appUrl ? `${this.appUrl}${event.reconnectPath}` : undefined;
    for (const owner of owners) {
      await this.emailQueue.enqueue(
        {
          kind: 'connection.broken',
          to: owner.email,
          ...connectionBrokenEmail({
            firstName: owner.firstName,
            organizationName: org.name,
            providerLabel: event.providerLabel,
            account: event.account ?? null,
            impact: event.impact,
            reconnectUrl,
          }),
        },
        { dedupeKey: `connection.broken:${event.connectionId}:${event.brokenAt.getTime()}:${owner.id}` },
      );
    }
    this.logger.log(`${event.providerLabel} disconnect alert queued for ${owners.length} owner(s) of organization ${event.orgId}`);
  }
}

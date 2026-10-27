import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '@/common/service/mail.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { AppEnv } from '@/common/utils/interface';
import { EmailQueue } from '@/queue/email/email.queue';
import { fullName } from './lead-scope';
import { leadAssignedEmail } from './templates/lead-assigned-email';

export interface LeadAssignedEvent {
  orgId: string;
  leadId: string;
  agentId: string;
  actorId: string | null;
  previousAgentId: string | null;
  assignedAt: Date;
}

@Injectable()
export class LeadAssignmentNotifier {
  private readonly logger = new Logger(LeadAssignmentNotifier.name);
  private readonly appUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailQueue: EmailQueue,
    config: ConfigService<AppEnv, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true })?.replace(/\/+$/, '');
  }

  leadAssigned(event: LeadAssignedEvent): void {
    if (!this.mail.enabled) return;
    void this.send(event).catch((error) =>
      this.logger.error(`Could not queue the lead-assigned email for lead ${event.leadId}: ${(error as Error).message}`),
    );
  }

  private async send(event: LeadAssignedEvent): Promise<void> {
    const [lead, agent, actor] = await Promise.all([
      this.prisma.lead.findFirst({
        where: { id: event.leadId, orgId: event.orgId },
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          status: true,
          temperature: true,
          location: true,
          timeline: true,
          aiSummary: true,
          assignedToId: true,
          leadSource: { select: { name: true } },
        },
      }),
      this.prisma.user.findFirst({
        where: { id: event.agentId, orgId: event.orgId },
        select: { email: true, firstName: true, status: true, organization: { select: { name: true } } },
      }),
      event.actorId
        ? this.prisma.user.findFirst({
            where: { id: event.actorId, orgId: event.orgId },
            select: { firstName: true, lastName: true },
          })
        : null,
    ]);
    if (!lead || !agent || agent.status !== 'active' || lead.assignedToId !== event.agentId) return;

    const leadUrl = this.appUrl ? `${this.appUrl}/leads?lead=${encodeURIComponent(event.leadId)}` : undefined;
    await this.emailQueue.enqueue(
      {
        kind: 'lead.assigned',
        to: agent.email,
        ...leadAssignedEmail({
          agentFirstName: agent.firstName,
          organizationName: agent.organization.name,
          assignedByName: actor ? fullName(actor.firstName, actor.lastName, 'A teammate') : null,
          reassigned: event.previousAgentId !== null,
          selfAssigned: event.actorId === event.agentId,
          lead: {
            name: fullName(lead.firstName, lead.lastName, lead.phone ?? lead.email ?? 'Unnamed lead'),
            phone: lead.phone,
            email: lead.email,
            source: lead.leadSource?.name ?? null,
            status: lead.status,
            temperature: lead.temperature,
            location: lead.location,
            timeline: lead.timeline,
            summary: lead.aiSummary,
          },
          leadUrl,
        }),
      },
      { dedupeKey: `lead.assigned:${event.leadId}:${event.agentId}:${event.assignedAt.getTime()}` },
    );
  }
}

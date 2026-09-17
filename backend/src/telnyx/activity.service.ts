import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { CredStoreService } from './cred-store.service';

/**
 * Records contact attempts and their outcomes on the real tables:
 *  - SMS   -> messages.delivery_status  (sent | failed)
 *  - calls -> voice_calls.status        (ringing -> in_progress -> completed | no_answer | failed)
 *
 * The lead's pipeline status moves to 'contacted' only when we actually reach
 * them (SMS accepted, or a call answered) — outcomes like "no answer" live on
 * the call record.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    // Unguarded by necessity, for callByProvider only. Telnyx's webhook gives us
    // a call_control_id and nothing else — discovering which tenant the call
    // belongs to IS the query, so there is no organization id to scope it by.
    private readonly unscoped: PrismaService,
    private readonly creds: CredStoreService,
  ) {}

  private async findOrCreateConversation(orgId: string, leadId: string, channel: 'sms' | 'voice') {
    const existing = await this.prisma.conversations.findFirst({
      where: { organization_id: orgId, lead_id: leadId, channel },
    });
    if (existing) return existing;
    return this.prisma.conversations.create({
      data: { organization_id: orgId, lead_id: leadId, channel, status: 'active' },
    });
  }

  private async markContacted(leadId: string, response = false): Promise<void> {
    await this.prisma.leads.updateMany({ where: { id: leadId, status: 'new' }, data: { status: 'contacted' } });
    await this.prisma.leads
      .update({
        where: { id: leadId },
        data: { last_contact_at: new Date(), ...(response ? { first_response_at: new Date() } : {}) },
      })
      .catch(() => undefined);
  }

  async recordSms(
    orgId: string,
    leadId: string,
    text: string,
    ok: boolean,
    providerId?: string | null,
  ): Promise<void> {
    try {
      const conv = await this.findOrCreateConversation(orgId, leadId, 'sms');
      await this.prisma.messages.create({
        data: {
          conversation_id: conv.id,
          organization_id: orgId,
          sender_type: 'ai',
          direction: 'outbound',
          channel: 'sms',
          body: text,
          provider_message_id: providerId ?? null,
          delivery_status: ok ? 'sent' : 'failed',
          sent_at: new Date(),
          ...(ok ? {} : { failed_at: new Date() }),
        },
      });
    } catch (e) {
      this.logger.error(`recordSms: ${(e as Error).message}`);
    }
    if (ok) await this.markContacted(leadId);
  }

  async startCall(orgId: string, leadId: string, providerCallId?: string | null): Promise<void> {
    try {
      await this.prisma.voice_calls.create({
        data: {
          organization_id: orgId,
          lead_id: leadId,
          provider: 'telnyx',
          provider_call_id: providerCallId ?? null,
          direction: 'outbound',
          status: 'ringing',
          started_at: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`startCall: ${(e as Error).message}`);
    }
    // The lead is 'contacted' once the call is PLACED; the outcome lands on the
    // call row rather than on the lead.
    await this.markContacted(leadId);
  }

  async recordCallFailed(orgId: string, leadId: string): Promise<void> {
    try {
      await this.prisma.voice_calls.create({
        data: {
          organization_id: orgId,
          lead_id: leadId,
          provider: 'telnyx',
          direction: 'outbound',
          status: 'failed',
          started_at: new Date(),
          ended_at: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`recordCallFailed: ${(e as Error).message}`);
    }
  }

  /** See the `unscoped` note on the constructor: this resolves the tenant. */
  private callByProvider(ccid: string) {
    return this.unscoped.voice_calls.findFirst({
      where: { provider_call_id: ccid },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Call answered — mark in progress, move the lead to contacted, attach the AI. */
  async onCallAnswered(ccid: string): Promise<void> {
    const call = await this.callByProvider(ccid);
    if (!call || !call.lead_id) return;
    await this.prisma.voice_calls.update({ where: { id: call.id }, data: { status: 'in_progress' } });
    await this.markContacted(call.lead_id, true);

    // Attach the org's AI assistant so the answered call actually talks.
    const c = await this.creds.getCreds(call.organization_id);
    if (c?.assistantId) {
      await fetch(`https://api.telnyx.com/v2/calls/${ccid}/actions/ai_assistant_start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: c.assistantId } }),
      }).catch(() => undefined);
    }
  }

  /** Call ended — completed if it had been answered, else no_answer. */
  async onCallHangup(ccid: string): Promise<void> {
    const call = await this.callByProvider(ccid);
    if (!call) return;
    const answered = call.status === 'in_progress';
    const dur = call.started_at
      ? Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000)
      : null;
    await this.prisma.voice_calls.update({
      where: { id: call.id },
      data: { status: answered ? 'completed' : 'no_answer', ended_at: new Date(), duration_seconds: dur },
    });
  }
}

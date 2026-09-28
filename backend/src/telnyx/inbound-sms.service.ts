import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizePhone } from '../ingest/parse';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Inbound SMS: the reply path, and the only way a lead can make us stop.
 *
 * Before this there was no inbound route at all, which meant `leads.dnc_status`
 * could never become true — every DNC check in the engine was reading a flag
 * nothing could set. Automated SMS over a period of weeks with no working
 * opt-out is a legal exposure, not a gap to tidy up later, so this lands with
 * the capture stage rather than with the follow-up runner that needs it.
 *
 * Three things happen on every inbound message, in order of how much they
 * matter: an opt-out is honoured, the reply is stored, and the lead's
 * automation is paused so we are not texting over a live human conversation.
 */
@Injectable()
export class InboundSmsService {
  private readonly logger = new Logger(InboundSmsService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    // Unguarded by necessity, exactly as ActivityService.callByProvider is.
    // Telnyx's messaging webhook identifies the tenant only by which of our
    // numbers was texted, so discovering the organization IS the query.
    private readonly unscoped: PrismaService,
  ) {}

  /**
   * The carrier-standard opt-out keywords. Telnyx also auto-unsubscribes on
   * these at the messaging-profile level; we mirror it onto the lead rather
   * than trust it, because the carrier's suppression list is invisible to our
   * own UI and to every DNC check the engine already makes.
   *
   * Matched on the whole message, not as a substring: "stop by the open house
   * on Sunday" is not an opt-out, and treating it as one loses a live lead.
   */
  private static readonly STOP_WORDS = new Set([
    'stop',
    'stopall',
    'unsubscribe',
    'cancel',
    'end',
    'quit',
    'revoke',
    'optout',
    'opt-out',
  ]);

  /** Carrier-standard opt-BACK-in. See onOptIn for why this does not resume a sequence. */
  private static readonly START_WORDS = new Set(['start', 'unstop', 'yes']);

  private static keyword(text: string): string {
    return text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  }

  /**
   * Which tenant owns the number that was texted.
   *
   * Prefers the active account but does not require one: an office that has
   * disconnected its Telnyx account can still receive a STOP from someone it
   * texted last week, and that STOP must be honoured. Ignoring it because a
   * credential row is inactive would be the wrong kind of correct.
   */
  private async orgForNumber(to: string): Promise<string | null> {
    const rows = await this.unscoped.integrations.findMany({
      where: { provider: 'telnyx', metadata: { path: ['fromNumber'], equals: to } },
      select: { organization_id: true, status: true },
    });
    if (rows.length === 0) return null;
    return (rows.find((r) => r.status === 'active') ?? rows[0]).organization_id;
  }

  /** The lead this number belongs to, most recently created first. */
  private async leadForNumber(orgId: string, from: string) {
    return this.unscoped.leads.findFirst({
      where: { organization_id: orgId, normalized_phone: from },
      orderBy: { created_at: 'desc' },
      select: { id: true, status: true, first_response_at: true },
    });
  }

  private async findOrCreateConversation(orgId: string, leadId: string) {
    const existing = await this.prisma.conversations.findFirst({
      where: { organization_id: orgId, lead_id: leadId, channel: 'sms' },
    });
    if (existing) return existing;
    return this.prisma.conversations.create({
      data: { organization_id: orgId, lead_id: leadId, channel: 'sms', status: 'active' },
    });
  }

  /**
   * Handle one `message.received` payload.
   *
   * Everything is best-effort and logged rather than thrown: the controller has
   * already answered 200, and Telnyx retries any non-2xx, so raising here would
   * only turn one unparseable message into a delivery loop.
   */
  async onMessageReceived(payload: any): Promise<void> {
    const from = normalizePhone(payload?.from?.phone_number);
    const to = normalizePhone(payload?.to?.[0]?.phone_number ?? payload?.to?.phone_number);
    const text = String(payload?.text ?? '');
    const providerId: string | null = payload?.id ?? null;

    if (!from || !to) {
      this.logger.warn('message.received without a usable from/to');
      return;
    }

    const orgId = await this.orgForNumber(to);
    if (!orgId) {
      this.logger.warn(`message.received for ${to}, which no organization owns`);
      return;
    }

    // Telnyx retries on any non-2xx, and a retry after a slow write would
    // otherwise store the reply twice and re-pause an already-paused lead.
    if (providerId) {
      const seen = await this.unscoped.messages.findFirst({
        where: { provider_message_id: providerId, direction: 'inbound' },
        select: { id: true },
      });
      if (seen) return;
    }

    const lead = await this.leadForNumber(orgId, from);
    if (!lead) {
      // Worth a log rather than silence: a reply from a number we have no lead
      // for usually means the lead was deleted, or the number was reassigned.
      this.logger.warn(`Inbound SMS from ${from} matches no lead in org ${orgId}`);
      return;
    }

    await this.storeInbound(orgId, lead.id, text, providerId);

    const keyword = InboundSmsService.keyword(text);
    if (InboundSmsService.STOP_WORDS.has(keyword)) {
      await this.onOptOut(orgId, lead.id);
      return;
    }
    if (InboundSmsService.START_WORDS.has(keyword)) {
      await this.onOptIn(orgId, lead.id);
      return;
    }

    await this.onHumanReply(orgId, lead.id, !lead.first_response_at);
  }

  private async storeInbound(
    orgId: string,
    leadId: string,
    text: string,
    providerId: string | null,
  ): Promise<void> {
    try {
      const conv = await this.findOrCreateConversation(orgId, leadId);
      await this.prisma.messages.create({
        data: {
          conversation_id: conv.id,
          organization_id: orgId,
          sender_type: 'lead',
          direction: 'inbound',
          channel: 'sms',
          body: text,
          provider_message_id: providerId,
          // An inbound message is delivered by definition — it is in our hands.
          delivery_status: 'delivered',
          sent_at: new Date(),
          delivered_at: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`storeInbound: ${(e as Error).message}`);
    }
  }

  /**
   * Hard stop. Do-not-contact, automation paused, every scheduled follow-up
   * step cancelled, status terminal.
   *
   * One UPDATE cancels the lead's entire future, which is the whole argument
   * for keeping follow-up in `sequence_enrollments.next_action_at` instead of
   * in-process timers: there is nothing here that a running process has to be
   * asked nicely to forget.
   */
  private async onOptOut(orgId: string, leadId: string): Promise<void> {
    try {
      await this.prisma.leads.update({
        where: { id: leadId },
        data: {
          dnc_status: true,
          automation_paused: true,
          // 'lost', NOT 'dnc'. leads_status_check permits exactly
          // new|contacted|qualified|nurture|booked|closed|lost, so 'dnc' was
          // rejected by the database — and because it travelled in the SAME
          // statement as dnc_status, the whole write was lost and the catch
          // below swallowed it. Every opt-out silently did nothing: the flag
          // the runner gates on stayed false and the sequence kept sending.
          //
          // Do-not-contact is carried by dnc_status, which is what every gate
          // actually reads. The pipeline column says where the lead is, and
          // somebody who has told us to stop is out of it.
          status: 'lost',
          lost_reason: 'Opted out by SMS',
          consent_status: 'revoked',
          first_response_at: new Date(),
          last_contact_at: new Date(),
        },
      });
      await this.cancelEnrollments(orgId, leadId, 'opted_out');
      this.logger.log(`lead ${leadId} opted out — DNC set, sequences cancelled`);
    } catch (e) {
      this.logger.error(`onOptOut: ${(e as Error).message}`);
    }
  }

  /**
   * Carrier-standard opt back in. Clears do-not-contact — texting START is
   * explicit re-consent, and refusing to honour it would mean a lead who asks
   * us to resume can never be contacted again.
   *
   * It deliberately does NOT resume the cancelled sequence or un-pause
   * automation. Consenting to hear from us is not the same as asking to be put
   * back into a twenty-one-day drip; a human decides what to send next.
   */
  private async onOptIn(orgId: string, leadId: string): Promise<void> {
    try {
      await this.prisma.leads.update({
        where: { id: leadId },
        data: {
          dnc_status: false,
          consent_status: 'granted',
          consent_at: new Date(),
          consent_source: 'sms_start',
          first_response_at: new Date(),
          last_contact_at: new Date(),
        },
      });
      this.logger.log(`lead ${leadId} opted back in — DNC cleared, automation still paused`);
    } catch (e) {
      this.logger.error(`onOptIn: ${(e as Error).message}`);
    }
  }

  /**
   * An ordinary reply. Stamp first response if this is the first one, and pause
   * the sequence: a human is talking to us, and a drip message landing in the
   * middle of that conversation reads as nobody being home.
   *
   * Whether the reply is positive enough to route the lead to an agent is a
   * judgement this stage cannot make — there is no LLM in the backend — so it
   * pauses and leaves the lead for a person. Stage 2.2 revisits it.
   */
  private async onHumanReply(orgId: string, leadId: string, isFirst: boolean): Promise<void> {
    try {
      await this.prisma.leads.update({
        where: { id: leadId },
        data: {
          automation_paused: true,
          last_contact_at: new Date(),
          ...(isFirst ? { first_response_at: new Date() } : {}),
        },
      });
      await this.pauseEnrollments(orgId, leadId);
    } catch (e) {
      this.logger.error(`onHumanReply: ${(e as Error).message}`);
    }
  }

  /**
   * Stop every future step for a lead, for good. `next_action_at` is nulled as
   * well as the status changed, so a cancelled enrollment can never be picked
   * up by the runner's claim query even if its status is later hand-edited.
   *
   * A row the runner has claimed is still 'active' — the claim lives in
   * `locked_by`, not in the status — so this catches an in-flight step too.
   * The runner re-reads `dnc_status` immediately before sending for the same
   * reason: the message must not go out to somebody who just told us to stop.
   */
  private async cancelEnrollments(orgId: string, leadId: string, reason: string): Promise<void> {
    await this.prisma.sequence_enrollments.updateMany({
      where: {
        organization_id: orgId,
        lead_id: leadId,
        status: { in: ['active', 'paused'] },
      },
      data: {
        status: 'stopped',
        stopped_at: new Date(),
        stopped_reason: reason,
        next_action_at: null,
      },
    });
  }

  /** Reversible, unlike cancelEnrollments: the lead may go quiet again. */
  private async pauseEnrollments(orgId: string, leadId: string): Promise<void> {
    await this.prisma.sequence_enrollments.updateMany({
      where: { organization_id: orgId, lead_id: leadId, status: 'active' },
      data: { status: 'paused', next_action_at: null },
    });
  }
}

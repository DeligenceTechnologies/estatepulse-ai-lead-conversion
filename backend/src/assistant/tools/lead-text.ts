import { ConsentStatus, type Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { spoken } from '@/calendar/booking/booking-time';
import { AppError } from '@/common/errors/app-error';
import type { PrismaService } from '@/common/prisma/prisma.service';
import { contactZone, leadZone } from '@/common/utils/lead-timezone';
import { nextLeadContactAt } from '@/common/utils/quiet-hours';
import type { EventsBus } from '@/events/events.bus';
import type { FollowupService } from '@/followup/followup.service';
import { isSuppressed } from '@/lead/contact-suppression';
import { fullName } from '@/lead/lead-scope';
import type { LeadStateService } from '@/lead/lead-state.service';
import type { OptOutService } from '@/telnyx/opt-out.service';
import { OptedOutError, type SmsService } from '@/telnyx/sms.service';
import type { SmsConversationService } from '@/telnyx/sms/sms-conversation.service';
import { agentMessageForAi } from '@/telnyx/sms/sms-prompt';

export interface LeadTextDeps {
  prisma: PrismaService;
  sms: SmsService;
  conversations: SmsConversationService;
  optOuts: OptOutService;
  followup: FollowupService;
  state: LeadStateService;
  events: EventsBus;
}

export const MAX_TEXT = 640;
/** A card can wait up to 10 minutes; a send that slips this far past the window's start still counts as on time. */
const WINDOW_SLACK_MS = 60_000;

/** What a text needs to know about the lead. */
export const TEXT_LEAD = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  normalizedPhone: true,
  timezone: true,
  dncStatus: true,
  consentStatus: true,
  takenOverById: true,
  takenOverBy: { select: { firstName: true, lastName: true, email: true } },
  updatedAt: true,
} satisfies Prisma.LeadSelect;

export type TextLead = Prisma.LeadGetPayload<{ select: typeof TEXT_LEAD }>;

/**
 * Why a person's text cannot go to the lead now, or null when it can: no number, do-not-contact,
 * no consent (pending counts as none), an agent holding the chat, or outside the hours we text in on the lead's clock
 * (the law's windows and the office's quiet hours; the office's days off are for automated outreach).
 */
export async function textBlocker(deps: Pick<LeadTextDeps, 'prisma' | 'followup'>, auth: AuthContext, lead: TextLead, now = new Date()): Promise<string | null> {
  if (!lead.phone || !lead.normalizedPhone) return 'This lead has no phone number to text.';
  if (lead.dncStatus) return 'This lead asked not to be contacted.';
  if (lead.consentStatus === ConsentStatus.revoked) return 'This lead withdrew consent to be contacted.';
  if (lead.consentStatus !== ConsentStatus.granted) {
    return "This lead has not given consent to be texted, so the assistant does not text them. Record their consent on the lead's page first.";
  }
  if (await isSuppressed(deps.prisma, auth.organizationId, lead.normalizedPhone)) return 'This number asked not to be contacted.';
  if (lead.takenOverById && lead.takenOverById !== auth.userId) {
    const holder = lead.takenOverBy ? fullName(lead.takenOverBy.firstName, lead.takenOverBy.lastName, lead.takenOverBy.email) : 'An agent';
    return `${holder} has taken over this lead's text chat and is answering personally, so the assistant does not text them.`;
  }

  const { quiet } = await deps.followup.guardrailsFor(auth.organizationId);
  const zone = leadZone(lead);
  const verdict = nextLeadContactAt(zone, { quiet, skipDays: [] }, now);
  if (!verdict.allowedAt) return verdict.reason;
  if (verdict.allowedAt.getTime() > now.getTime() + WINDOW_SLACK_MS) {
    const when = spoken(verdict.allowedAt, contactZone(zone) ?? 'UTC');
    return `It is outside texting hours on the lead's clock${verdict.reason ? ` (${verdict.reason})` : ''}. The earliest it can go is ${when}. The assistant cannot schedule a text for later, so the user has to ask again then.`;
  }
  return null;
}

/** Lines for the card that the person should know before a text goes. */
export function textNotes(auth: AuthContext, lead: TextLead): string {
  const notes = [
    'It goes from the office number; a short opt-out line is added if the rules ask for one.',
    ...(lead.takenOverById === auth.userId ? [] : ['If they reply, the AI answers in the text chat.']),
  ];
  return notes.join(' ');
}

/**
 * Sends a person's text to the lead from the office number, as theirs: kept on the lead's thread
 * under their name, and added to the AI's copy of the chat so its next reply knows about it.
 * A number that replied STOP to us is opted out on the spot, as an automated text would do.
 */
export async function sendLeadText(deps: LeadTextDeps, auth: AuthContext, lead: TextLead, text: string): Promise<{ text: string; footerAdded: boolean }> {
  const { prisma } = deps;
  const orgId = auth.organizationId;
  const phone = lead.phone!;
  const row = await prisma.message.create({
    data: { orgId, leadId: lead.id, direction: 'outbound', channel: 'sms', senderType: 'user', senderUserId: auth.userId, body: text, deliveryStatus: 'pending' },
  });

  let sent: { id?: string; text: string };
  try {
    sent = await deps.sms.sendSms(orgId, phone, text, { outreach: true });
  } catch (error) {
    await prisma.message.update({ where: { id: row.id }, data: { deliveryStatus: 'failed', failedAt: new Date() } });
    changed(deps, orgId, lead.id);
    if (error instanceof OptedOutError) {
      await deps.optOuts.optOut(orgId, { leadId: lead.id }, { source: 'sms_send', reason: error.message, channel: 'sms', actor: { type: 'user', id: auth.userId } });
      throw new AppError('CONFLICT', 'This number replied STOP to us, so the text was not sent. The lead is now do-not-contact.');
    }
    throw new AppError('UPSTREAM_ERROR', `The text was not sent: ${(error as Error).message}`);
  }

  const sentAt = new Date();
  await prisma.message.update({ where: { id: row.id }, data: { body: sent.text, providerMessageId: sent.id ?? null, deliveryStatus: 'sent', sentAt } });
  await prisma.lead.update({ where: { id: lead.id }, data: { lastContactAt: sentAt } });
  const user = await prisma.user.findFirst({ where: { id: auth.userId, orgId }, select: { firstName: true, lastName: true, email: true } });
  const sender = user ? fullName(user.firstName, user.lastName, user.email) : 'Agent';
  deps.conversations
    .appendToChat(orgId, phone, 'assistant', agentMessageForAi(sender, sent.text), sentAt)
    .catch(() => undefined);
  deps.state.quietly({
    orgId,
    leadId: lead.id,
    type: 'text_sent',
    source: 'assistant',
    channel: 'sms',
    actor: { type: 'user', id: auth.userId },
    reason: 'Texted through Ask EstatePulse',
  });
  changed(deps, orgId, lead.id);
  return { text: sent.text, footerAdded: sent.text !== text };
}

function changed(deps: Pick<LeadTextDeps, 'events'>, orgId: string, leadId: string): void {
  deps.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId });
}

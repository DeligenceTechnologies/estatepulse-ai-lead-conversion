import { prisma } from '../db';
import { getCreds } from './credStore';

/**
 * Records contact attempts and their outcomes on the real tables:
 *  - SMS   -> messages.delivery_status  (sent | failed)
 *  - calls -> voice_calls.status        (ringing -> in_progress -> completed | no_answer | failed)
 * The lead's pipeline status moves to 'contacted' only when we actually reach them
 * (SMS accepted, or a call answered) — outcomes like "no answer" live on the call record.
 */

async function findOrCreateConversation(orgId: string, leadId: string, channel: 'sms' | 'voice') {
  const existing = await prisma.conversations.findFirst({ where: { organization_id: orgId, lead_id: leadId, channel } });
  if (existing) return existing;
  return prisma.conversations.create({ data: { organization_id: orgId, lead_id: leadId, channel, status: 'active' } });
}

async function markContacted(leadId: string, response = false): Promise<void> {
  await prisma.leads.updateMany({ where: { id: leadId, status: 'new' }, data: { status: 'contacted' } });
  await prisma.leads
    .update({ where: { id: leadId }, data: { last_contact_at: new Date(), ...(response ? { first_response_at: new Date() } : {}) } })
    .catch(() => {});
}

export async function recordSms(orgId: string, leadId: string, text: string, ok: boolean, providerId?: string | null): Promise<void> {
  try {
    const conv = await findOrCreateConversation(orgId, leadId, 'sms');
    await prisma.messages.create({
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
    console.error('[activity] recordSms:', (e as Error).message);
  }
  if (ok) await markContacted(leadId);
}

export async function startCall(orgId: string, leadId: string, providerCallId?: string | null): Promise<void> {
  try {
    await prisma.voice_calls.create({
      data: { organization_id: orgId, lead_id: leadId, provider: 'telnyx', provider_call_id: providerCallId ?? null, direction: 'outbound', status: 'ringing', started_at: new Date() },
    });
  } catch (e) {
    console.error('[activity] startCall:', (e as Error).message);
  }
  // Milestone 1: the lead is 'contacted' once the call is PLACED (outcome lands on the call row).
  await markContacted(leadId);
}

export async function recordCallFailed(orgId: string, leadId: string): Promise<void> {
  try {
    await prisma.voice_calls.create({
      data: { organization_id: orgId, lead_id: leadId, provider: 'telnyx', direction: 'outbound', status: 'failed', started_at: new Date(), ended_at: new Date() },
    });
  } catch (e) {
    console.error('[activity] recordCallFailed:', (e as Error).message);
  }
}

const callByProvider = (ccid: string) => prisma.voice_calls.findFirst({ where: { provider_call_id: ccid }, orderBy: { created_at: 'desc' } });

/** Call answered — mark in progress, move the lead to contacted, and attach the AI assistant. */
export async function onCallAnswered(ccid: string): Promise<void> {
  const call = await callByProvider(ccid);
  if (!call || !call.lead_id) return;
  await prisma.voice_calls.update({ where: { id: call.id }, data: { status: 'in_progress' } });
  await markContacted(call.lead_id, true);

  // Attach the org's AI assistant so the answered call actually talks.
  const c = await getCreds(call.organization_id);
  if (c?.assistantId) {
    await fetch(`https://api.telnyx.com/v2/calls/${ccid}/actions/ai_assistant_start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: { id: c.assistantId } }),
    }).catch(() => {});
  }
}

/** Call ended — completed if it had been answered, else no_answer. */
export async function onCallHangup(ccid: string): Promise<void> {
  const call = await callByProvider(ccid);
  if (!call) return;
  const answered = call.status === 'in_progress';
  const dur = call.started_at ? Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000) : null;
  await prisma.voice_calls.update({ where: { id: call.id }, data: { status: answered ? 'completed' : 'no_answer', ended_at: new Date(), duration_seconds: dur } });
}

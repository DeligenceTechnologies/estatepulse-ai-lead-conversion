import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { CredStoreService } from './cred-store.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

  /**
   * The last argument is the provider's message id on success, and the failure
   * reason on failure — one parameter because the caller has exactly one of
   * them and never both.
   */
  async recordSms(
    orgId: string,
    leadId: string,
    text: string,
    ok: boolean,
    providerIdOrReason?: string | null,
  ): Promise<void> {
    const providerId = ok ? providerIdOrReason : null;
    const reason = ok ? undefined : providerIdOrReason || undefined;
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
    if (ok) {
      await this.markContacted(leadId);
    } else {
      // A failed text is recorded but does NOT end the strategy - the lead keeps going.
      await this.noteAttemptFailure(leadId, reason ? `SMS failed: ${reason}` : 'SMS failed');
    }
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

  /** The call could not be placed at all (provider error). Does NOT exit the strategy. */
  /**
   * Park a lead in 'nurture' (follow-up needed) with a human reason, so a lead
   * we could not reach reads as attempted rather than untouched. Per the state
   * machine: no answer / not ready -> Nurture. The reason surfaces in the UI on
   * hover (leads.ai_summary -> statusReason).
   *
   * Only 'new' and 'contacted' move: a lead that already reached qualified,
   * booked, closed or lost has a further status that this must never walk back.
   */
  private async moveToFollowup(leadId: string, reason: string): Promise<void> {
    try {
      await this.prisma.leads.updateMany({
        where: { id: leadId, status: { in: ['new', 'contacted'] } },
        data: { status: 'nurture', ai_summary: reason.slice(0, 2000), last_contact_at: new Date() },
      });
    } catch (e) {
      this.logger.error(`moveToFollowup: ${(e as Error).message}`);
    }
  }

  /**
   * Record one failed attempt WITHOUT ending the strategy. The lead keeps its
   * status and continues to the next step; only the latest reason is noted, so
   * the UI can say "last attempt failed: …" while the lead is still in strategy.
   * A lead leaves the strategy only via exitStrategy, once every step has run.
   */
  private async noteAttemptFailure(leadId: string, reason: string): Promise<void> {
    try {
      await this.prisma.leads.updateMany({
        where: { id: leadId },
        data: { ai_summary: reason.slice(0, 2000), last_contact_at: new Date() },
      });
    } catch (e) {
      this.logger.error(`noteAttemptFailure: ${(e as Error).message}`);
    }
  }

  /** The whole strategy ran without converting -> park the lead in follow-up. */
  async exitStrategy(leadId: string, reason: string): Promise<void> {
    await this.moveToFollowup(leadId, reason);
  }

  /**
   * The call could not be placed at all (a provider error). Notes the reason and
   * does NOT exit the strategy.
   */
  async recordCallFailed(orgId: string, leadId: string, reason?: string): Promise<void> {
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
    await this.noteAttemptFailure(leadId, reason ? `Call failed: ${reason}` : 'Call failed');
  }

  /** See the `unscoped` note on the constructor: this resolves the tenant. */
  private callByProvider(ccid: string) {
    return this.unscoped.voice_calls.findFirst({
      where: { provider_call_id: ccid },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Call answered — mark in progress, move the lead to contacted, record, attach the AI. */
  async onCallAnswered(ccid: string): Promise<void> {
    const call = await this.callByProvider(ccid);
    if (!call || !call.lead_id) return;
    await this.prisma.voice_calls.update({ where: { id: call.id }, data: { status: 'in_progress' } });
    await this.markContacted(call.lead_id, true);

    const c = await this.creds.getCreds(call.organization_id);
    if (!c?.apiKey) return;

    // Recording starts BEFORE the assistant does, deliberately: the assistant's
    // opening line is the recording announcement, and an announcement that is
    // not itself on the recording proves nothing if consent is ever disputed.
    await this.startRecording(call.organization_id, ccid, c.apiKey);

    // Attach the org's AI assistant so the answered call actually talks.
    if (c.assistantId) {
      await fetch(`https://api.telnyx.com/v2/calls/${ccid}/actions/ai_assistant_start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: { id: c.assistantId },
          // What the assistant is allowed to know about who it just reached.
          // Without these the prompt can only ever speak in generalities, and
          // every {{firstName}} in it renders as the literal braces.
          dynamic_variables: await this.callVariables(call.organization_id, call.lead_id),
        }),
      }).catch(() => undefined);
    }
  }

  /**
   * The lead, flattened into the variables a prompt or a webhook tool can
   * reference as `{{name}}`.
   *
   * Every value is a string: Telnyx substitutes these into text, and a null
   * would render as the word "null" mid-sentence. An unknown field is therefore
   * the empty string, which reads as nothing at all.
   *
   * These names are the contract the portal's variable picker offers, so adding
   * one here is what makes it offerable there — the two lists are meant to be
   * read together.
   */
  private async callVariables(orgId: string, leadId: string): Promise<Record<string, string>> {
    const lead = await this.prisma.leads
      .findFirst({ where: { id: leadId, organization_id: orgId } })
      .catch(() => null);
    if (!lead) return {};

    const org = await this.unscoped.organizations
      .findUnique({ where: { id: orgId }, select: { name: true } })
      .catch(() => null);

    const str = (v: unknown): string => (v == null ? '' : String(v));
    const budget =
      lead.min_budget != null && lead.max_budget != null
        ? `${Number(lead.min_budget).toLocaleString()} to ${Number(lead.max_budget).toLocaleString()}`
        : str(lead.max_budget ?? lead.min_budget);

    return {
      // 'there' so a greeting reads "Hi there" rather than "Hi ," when a form
      // arrived without a name.
      firstName: (lead.first_name ?? '').trim() || 'there',
      lastName: str(lead.last_name),
      fullName: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
      email: str(lead.email),
      phone: str(lead.phone),
      location: str(lead.location),
      budget,
      bedrooms: str(lead.bedrooms),
      timeline: str(lead.timeline),
      financingStatus: str(lead.financing_status),
      temperature: str(lead.temperature),
      motivation: str(lead.motivation),
      brokerage: str(org?.name),
      leadId,
    };
  }

  /**
   * Ask Telnyx to record the answered call, and to transcribe it when it ends.
   *
   * Gated on the office's own setting because recording consent is
   * state-specific. Failure is logged and swallowed: a call that cannot be
   * recorded is still a call worth having, so this must never abort the
   * assistant attach that follows it.
   */
  private async startRecording(orgId: string, ccid: string, apiKey: string): Promise<void> {
    const org = await this.unscoped.organizations.findUnique({
      where: { id: orgId },
      select: { call_recording_enabled: true },
    });
    if (!org?.call_recording_enabled) return;

    try {
      const res = await fetch(`https://api.telnyx.com/v2/calls/${ccid}/actions/record_start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        // Dual channel puts the lead and the assistant on separate tracks, which
        // is what lets the transcript attribute a line to a speaker instead of
        // returning one undifferentiated block of text.
        body: JSON.stringify({ format: 'mp3', channels: 'dual', transcription: true }),
      });
      if (!res.ok) this.logger.warn(`record_start ${ccid}: ${res.status} ${await res.text()}`);
    } catch (e) {
      this.logger.warn(`record_start ${ccid}: ${(e as Error).message}`);
    }
  }

  /**
   * `call.recording.saved` — store where the audio lives.
   *
   * Telnyx offers the file under several keys depending on how the recording
   * was requested, so read them in preference order rather than assuming one.
   * The non-public URLs are the ones that require the account's own credentials
   * to fetch, which is what we want for a recording of a private conversation.
   */
  async onRecordingSaved(ccid: string, payload: any): Promise<void> {
    const url: string | null =
      payload?.recording_urls?.mp3 ??
      payload?.recording_urls?.wav ??
      payload?.public_recording_urls?.mp3 ??
      payload?.public_recording_urls?.wav ??
      null;
    if (!url) return;

    const call = await this.callByProvider(ccid);
    if (!call) return;
    try {
      await this.prisma.voice_calls.update({
        where: { id: call.id },
        data: { recording_url: url },
      });
    } catch (e) {
      this.logger.error(`onRecordingSaved: ${(e as Error).message}`);
    }
  }

  /**
   * `call.recording.transcription.saved` — store what was said.
   *
   * Appends rather than overwrites: a call can produce more than one recording
   * (a transfer, or a recording stopped and restarted), and each one arrives as
   * its own event. Overwriting would silently keep only the last fragment.
   */
  async onTranscriptionSaved(ccid: string, payload: any): Promise<void> {
    const text: string | null =
      payload?.transcription_text ??
      payload?.transcription_data?.transcription_text ??
      payload?.transcription?.text ??
      null;
    if (!text) return;

    const call = await this.callByProvider(ccid);
    if (!call) return;
    const merged = call.transcript ? `${call.transcript}

${text}` : text;
    try {
      await this.prisma.voice_calls.update({
        where: { id: call.id },
        data: { transcript: merged },
      });
    } catch (e) {
      this.logger.error(`onTranscriptionSaved: ${(e as Error).message}`);
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
    // No answer is recorded but does NOT end the strategy — the lead continues to
    // its next step, and leaves only once every step is exhausted (see the engine).
    if (!answered && call.lead_id) {
      await this.noteAttemptFailure(call.lead_id, 'No answer on the last call');
    }
  }
}

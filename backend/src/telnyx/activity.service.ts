import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { AUTO_FROM, FOLLOW_UP_STATUSES, FollowUpReason, IN_STRATEGY_STATUSES, LeadStatus } from '../common/domain';
import { AssistantService } from './assistant.service';
import { CredStoreService } from './cred-store.service';
import { LeadInsightsService } from './lead-insights.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Records contact attempts and their outcomes on the real tables:
 *  - SMS   -> messages.delivery_status  (sent | failed)
 *  - calls -> voice_calls.status        (ringing -> in_progress -> completed | no_answer | failed)
 *
 * The lead's pipeline status moves to 'contacting' once outreach starts —
 * outcomes like "no answer" live on the call record.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  /** Signed recording links, by `${orgId}:${callControlId}`. See freshRecordingUrl. */
  private readonly recordingLinks = new Map<string, { url: string; until: number }>();
  /**
   * Everything the AI attach needs, loaded while the phone rings, by
   * call_control_id. See prepareAttach.
   */
  private readonly prepared = new Map<string, Promise<AttachPlan | null>>();

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    // Unguarded by necessity, for callByProvider only. Telnyx's webhook gives us
    // a call_control_id and nothing else — discovering which tenant the call
    // belongs to IS the query, so there is no organization id to scope it by.
    private readonly unscoped: PrismaService,
    private readonly creds: CredStoreService,
    private readonly insights: LeadInsightsService,
    private readonly assistants: AssistantService,
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

  /**
   * Move a lead forward on the outreach ladder, never back: the update only
   * applies from the statuses AUTO_FROM allows, so a late webhook cannot undo a
   * later outcome.
   */
  private async advance(leadId: string, to: LeadStatus): Promise<void> {
    await this.prisma.leads
      .updateMany({ where: { id: leadId, status: { in: AUTO_FROM[to] ?? [] } }, data: { status: to } })
      .catch((e) => this.logger.error(`advance ${to}: ${(e as Error).message}`));
  }

  /** Outreach is under way (a call was dialled) but nobody has been reached yet. */
  private async markContacting(leadId: string): Promise<void> {
    await this.advance(leadId, LeadStatus.CONTACTING);
    await this.prisma.leads
      .update({ where: { id: leadId }, data: { last_contact_at: new Date() } })
      .catch(() => undefined);
  }

  private async markContacted(leadId: string, response = false): Promise<void> {
    await this.advance(leadId, LeadStatus.CONTACTING);
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
    // First, before any write: the ringing seconds are what pay for the attach.
    if (providerCallId) this.prepareAttach(providerCallId, orgId, leadId);
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
    await this.markContacting(leadId);
  }

  /** The call could not be placed at all (provider error). Does NOT exit the strategy. */
  /**
   * Park a lead the strategy could not convert in 'follow_up', with a human
   * reason, so it reads as attempted rather than untouched. The reason surfaces
   * in the UI on hover (leads.ai_summary -> statusReason).
   *
   * The follow-up reason comes from what was really recorded:
   *  - reached (a call answered, or a reply) -> not_ready: a person spoke and
   *    did not convert;
   *  - never reached -> no_answer.
   *
   * Only in-strategy statuses move: a lead that already reached an outcome has
   * a further status that this must never walk back.
   */
  private async moveToFollowup(leadId: string, reason: string): Promise<void> {
    try {
      const lead = await this.prisma.leads.findUnique({
        where: { id: leadId },
        select: { organization_id: true, first_response_at: true },
      });
      if (!lead) return;
      const answered = await this.prisma.voice_calls.count({
        where: { organization_id: lead.organization_id, lead_id: leadId, status: { in: ['completed', 'in_progress'] } },
      });
      const reached = answered > 0 || !!lead.first_response_at;
      await this.prisma.leads.updateMany({
        where: { id: leadId, status: { in: IN_STRATEGY_STATUSES } },
        data: {
          ai_summary: reason.slice(0, 2000),
          last_contact_at: new Date(),
          status: LeadStatus.FOLLOW_UP,
          follow_up_reason: reached ? FollowUpReason.NOT_READY : FollowUpReason.NO_ANSWER,
        },
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

  /**
   * Load what the AI attach needs while the call is still ringing.
   *
   * The database is a long way from this process (a round trip is around a
   * second), and the attach used to make about nine of them one after another
   * once the lead had already picked up — ten seconds and more of silence, long
   * enough that people hung up before the assistant said a word. Ringing takes
   * that long anyway, so the work moves there and the answer only has to talk
   * to Telnyx.
   *
   * Held in memory by call_control_id and dropped after PREPARED_TTL_MS; a call
   * this process did not dial (a restart, say) falls back to loading at answer.
   */
  private prepareAttach(ccid: string, orgId: string, leadId: string): Promise<AttachPlan | null> {
    const plan = (async (): Promise<AttachPlan | null> => {
      const c = await this.creds.getCreds(orgId);
      if (!c?.apiKey) return null;
      const [org, variables] = await Promise.all([
        this.unscoped.organizations.findUnique({ where: { id: orgId }, select: { call_recording_enabled: true } }),
        c.assistantId ? this.callVariables(orgId, leadId) : Promise.resolve({}),
        // The assistant reads its tools when it starts, so the hangup tool must
        // be in place before the attach. Only the first call per assistant per
        // process pays for it.
        c.assistantId ? this.assistants.ensureHangupTool(orgId) : Promise.resolve(),
      ]);
      // Make sure Telnyx will score this conversation when it ends. Never
      // blocks the call, and never throws.
      if (c.assistantId) void this.insights.ensureProvisioned(orgId);
      return {
        orgId,
        apiKey: c.apiKey,
        assistantId: c.assistantId || null,
        record: !!org?.call_recording_enabled,
        variables,
      };
    })().catch((e) => {
      this.logger.error(`prepare attach ${ccid}: ${(e as Error).message}`);
      return null;
    });
    this.prepared.set(ccid, plan);
    const t = setTimeout(() => this.prepared.delete(ccid), PREPARED_TTL_MS);
    if (t.unref) t.unref();
    return plan;
  }

  /**
   * Call answered — attach the AI first, bookkeeping alongside.
   *
   * Nothing the lead can hear waits on the database: the plan was loaded while
   * it rang (prepareAttach), and marking the call in progress runs in parallel
   * with the attach rather than ahead of it.
   */
  async onCallAnswered(ccid: string): Promise<void> {
    const bookkeeping = (async () => {
      const call = await this.callByProvider(ccid);
      if (!call?.lead_id) return null;
      await this.prisma.voice_calls.update({ where: { id: call.id }, data: { status: 'in_progress' } });
      await this.markContacted(call.lead_id, true);
      return call;
    })().catch((e) => {
      this.logger.error(`onCallAnswered bookkeeping ${ccid}: ${(e as Error).message}`);
      return null;
    });

    let plan = this.prepared.get(ccid);
    if (!plan) {
      // Not dialled by this process: find out who it is the slow way.
      this.logger.warn(`call ${ccid} answered with nothing prepared — loading now`);
      const call = await bookkeeping;
      if (!call?.lead_id) return;
      plan = this.prepareAttach(ccid, call.organization_id, call.lead_id);
    }
    const p = await plan;
    if (p) await this.attach(ccid, p);
    await bookkeeping;
  }

  /**
   * Recording starts BEFORE the assistant does, deliberately: the assistant's
   * opening line is the recording announcement, and an announcement that is
   * not itself on the recording proves nothing if consent is ever disputed.
   */
  private async attach(ccid: string, p: AttachPlan): Promise<void> {
    if (p.record) await this.startRecording(ccid, p.apiKey);
    if (!p.assistantId) return;
    try {
      const res = await fetch(`https://api.telnyx.com/v2/calls/${ccid}/actions/ai_assistant_start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: { id: p.assistantId },
          // What the assistant is allowed to know about who it just reached.
          // Without these the prompt can only ever speak in generalities, and
          // every {{firstName}} in it renders as the literal braces.
          dynamic_variables: p.variables,
        }),
      });
      // Logged, because a failed attach is a call where nobody ever speaks.
      if (!res.ok) this.logger.error(`ai_assistant_start ${ccid}: ${res.status} ${await res.text()}`);
    } catch (e) {
      this.logger.error(`ai_assistant_start ${ccid}: ${(e as Error).message}`);
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
   * Only when the office's own setting allows it (AttachPlan.record), because
   * recording consent is state-specific. Failure is logged and swallowed: a call
   * that cannot be recorded is still a call worth having, so this must never
   * abort the assistant attach that follows it.
   */
  private async startRecording(ccid: string, apiKey: string): Promise<void> {
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
   * A playable link to a call's recording, minted now.
   *
   * The URL Telnyx sends with `call.recording.saved` is a pre-signed S3 link
   * that expires ten minutes later (X-Amz-Expires=600), so the one stored on
   * the call is dead by the time anybody opens it — S3 answers 403 and the
   * player shows nothing. Telnyx signs a fresh link on every read of the
   * recording, so this asks again each time the call is opened.
   *
   * Never throws: null means "use what is stored", which is no worse than
   * before. The last recording wins, matching onRecordingSaved, which keeps
   * the last one to arrive.
   */
  async freshRecordingUrl(orgId: string, callControlId: string): Promise<string | null> {
    // Reused for half the link's life. The call view polls every few seconds,
    // and a new link on every poll changes the payload each time — the player's
    // src changes under it and playback restarts, and the poll never backs off.
    const key = `${orgId}:${callControlId}`;
    const hit = this.recordingLinks.get(key);
    if (hit && hit.until > Date.now()) return hit.url;
    try {
      const c = await this.creds.getCreds(orgId);
      if (!c?.apiKey) return null;
      const res = await fetch(
        `https://api.telnyx.com/v2/recordings?filter[call_control_id]=${encodeURIComponent(callControlId)}`,
        { headers: { Authorization: `Bearer ${c.apiKey}` } },
      );
      if (!res.ok) {
        this.logger.warn(`recordings ${callControlId}: ${res.status}`);
        return null;
      }
      const rows = (((await res.json()) as any).data ?? []) as any[];
      const urls = rows
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
        .map((r) => r.download_urls?.mp3 ?? r.download_urls?.wav)
        .filter(Boolean);
      const url = urls.length ? urls[urls.length - 1] : null;
      if (url) {
        if (this.recordingLinks.size > 500) this.recordingLinks.clear();
        this.recordingLinks.set(key, { url, until: Date.now() + RECORDING_LINK_REUSE_MS });
      }
      return url;
    } catch (e) {
      this.logger.warn(`recordings ${callControlId}: ${(e as Error).message}`);
      return null;
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

  /**
   * Call ended — completed if it had been answered, else no_answer.
   *
   * The payload adds two lead-level outcomes:
   *  - a hangup cause that means the number itself is bad -> 'invalid', and
   *    automation stops, since every further attempt would fail the same way;
   */
  async onCallHangup(ccid: string, payload: any = {}): Promise<void> {
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
    if (!call.lead_id) return;

    const cause = String(payload?.hangup_cause ?? '');
    if (INVALID_NUMBER_CAUSES.has(cause)) {
      await this.markInvalid(call.lead_id, `Invalid number (${cause})`);
      return;
    }

    if (answered) {
      return;
    }

    // No answer is recorded but does NOT end the strategy — the lead continues to
    // its next step, and leaves only once every step is exhausted (see the engine).
    await this.noteAttemptFailure(
      call.lead_id,
      cause ? `No answer on the last call (${cause})` : 'No answer on the last call',
    );
  }

  /**
   * The number cannot be reached at all. Terminal for automation — the engine
   * and the drip runner both stop on 'invalid' — but not for a person, who can
   * correct the number and move the lead on by hand.
   */
  async markInvalid(leadId: string, reason: string): Promise<void> {
    await this.prisma.leads
      .updateMany({
        where: { id: leadId, status: { in: [...IN_STRATEGY_STATUSES, ...FOLLOW_UP_STATUSES] } },
        data: { status: LeadStatus.INVALID, lost_reason: reason.slice(0, 255), ai_summary: reason },
      })
      .catch((e) => this.logger.error(`markInvalid: ${(e as Error).message}`));
  }
}

/** What attaching the AI to an answered call needs, loaded while it rings. */
interface AttachPlan {
  orgId: string;
  apiKey: string;
  assistantId: string | null;
  /** The office allows recording (organizations.call_recording_enabled). */
  record: boolean;
  variables: Record<string, string>;
}

/** Longer than any call rings; a plan nobody answered is dropped after it. */
const PREPARED_TTL_MS = 5 * 60 * 1000;

/** Telnyx signs recording links for ten minutes; reuse one for five. */
const RECORDING_LINK_REUSE_MS = 5 * 60 * 1000;

/**
 * Telnyx hangup causes that describe the number, not the moment. Busy, no
 * answer and rejected are deliberately absent: those are a person, and the
 * next attempt may well reach them.
 */
const INVALID_NUMBER_CAUSES = new Set(['unallocated_number', 'invalid_number_format', 'number_changed']);

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../../auth/types';
import { AppError } from '../../common/errors';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { normalizeLeadStatus } from '../../common/domain';

/**
 * Call and message history for the office.
 *
 * Read-only by construction, exactly as LeadsController is: history is written
 * by the Telnyx webhooks and by the engine, and nothing a browser sends should
 * be able to edit the record of what was said to whom.
 */

/** Only values we can honestly derive. BUSY / VOICEMAIL / WRONG_NUMBER are not among them. */
export type CallOutcome =
  | 'ANSWERED'
  | 'NO_ANSWER'
  | 'QUALIFIED'
  | 'APPOINTMENT_BOOKED'
  | 'HUMAN_HANDOFF'
  | 'NOT_INTERESTED'
  | 'FAILED'
  | 'IN_PROGRESS';

export interface CallListRow {
  id: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  temperature: string | null;
  provider: string;
  providerCallId: string | null;
  direction: string;
  status: string;
  outcome: CallOutcome;
  durationSeconds: number | null;
  /** Null when the office has recording off, or the file has not landed yet. */
  recordingUrl: string | null;
  /** Lets the list show a transcript affordance without shipping every transcript. */
  hasTranscript: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  agentId: string | null;
  agentName: string | null;
}

export interface CallDetail extends CallListRow {
  transcript: string | null;
  aiSummary: string | null;
  extractedIntel: unknown;
  handoffRequested: boolean;
  dncDetected: boolean;
}

export interface ConversationRow {
  id: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  temperature: string | null;
  status: string;
  channel: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
  lastMessageDirection: string | null;
  /** True once the lead has replied at least once. Drives "needs a human" in the UI. */
  hasInboundReply: boolean;
  dncStatus: boolean;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  direction: string;
  senderType: string;
  channel: string;
  body: string;
  deliveryStatus: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export interface CallFilters {
  limit?: string;
  agentId?: string;
  outcome?: string;
  temperature?: string;
  from?: string;
  to?: string;
  q?: string;
  /** Narrows to one lead, inside the caller's org and visibility — never instead of them. */
  leadId?: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const fullName = (first: string | null, last: string | null, fallback: string): string =>
  [first, last].filter(Boolean).join(' ').trim() || fallback;

/** One message as both message reads answer it. */
const toMessageRow = (m: {
  id: string;
  direction: string;
  sender_type: string;
  channel: string;
  body: string;
  delivery_status: string;
  sent_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
}): MessageRow => ({
  id: m.id,
  direction: m.direction,
  senderType: m.sender_type,
  channel: m.channel,
  body: m.body,
  deliveryStatus: m.delivery_status,
  sentAt: iso(m.sent_at),
  deliveredAt: iso(m.delivered_at),
  failedAt: iso(m.failed_at),
  createdAt: m.created_at.toISOString(),
});

@Injectable()
export class HistoryService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  /**
   * What this caller is allowed to see, as a `leads` where-fragment.
   *
   * An owner sees the whole office. An agent sees only leads currently assigned
   * to them — which today means an agent sees NOTHING, because routing (stage
   * 2.1) is what writes `lead_assignments` and it has not landed yet. That is
   * the correct failure direction: the alternative, showing an agent every call
   * in the office until routing exists, is a privacy leak that would be easy to
   * forget to close afterwards.
   */
  private leadScope(auth: AuthContext): Record<string, unknown> {
    if (auth.role === 'owner') return {};
    return {
      lead_assignments: {
        some: { agent_id: auth.agentProfileId ?? '', is_current: true },
      },
    };
  }

  /**
   * What happened on this call, in one word.
   *
   * Read from the call row first and the lead second: the lead's status is the
   * outcome of the whole relationship, and attributing "booked" to a call that
   * merely happened to be the last one before a booking would misreport the
   * history. Only the call-level signals — handoff, DNC — are allowed to
   * override, because those are recorded by the call itself.
   */
  private static outcomeOf(call: {
    status: string;
    handoff_requested: boolean;
    dnc_detected: boolean;
    duration_seconds: number | null;
  }): CallOutcome {
    if (call.dnc_detected) return 'NOT_INTERESTED';
    if (call.handoff_requested) return 'HUMAN_HANDOFF';
    switch (call.status) {
      case 'completed':
        return 'ANSWERED';
      case 'no_answer':
        return 'NO_ANSWER';
      case 'failed':
        return 'FAILED';
      case 'in_progress':
      case 'ringing':
      case 'queued':
        return 'IN_PROGRESS';
      default:
        return 'ANSWERED';
    }
  }

  /**
   * The lead-status outcomes, which are about the relationship rather than the
   * call. Applied only to the most recent call for a lead, so a three-call
   * history does not read as three separate bookings.
   */
  private static withLeadOutcome(base: CallOutcome, leadStatus: string, isLatest: boolean): CallOutcome {
    if (!isLatest) return base;
    if (base === 'NOT_INTERESTED' || base === 'HUMAN_HANDOFF') return base;
    // Legacy 'booked' still reads as booked (normalizeLeadStatus).
    const status = normalizeLeadStatus(leadStatus);
    if (status === 'appointment_booked') return 'APPOINTMENT_BOOKED';
    if (status === 'qualified' || status === 'appointment_requested') return 'QUALIFIED';
    if (status === 'dnc' || status === 'not_interested') return 'NOT_INTERESTED';
    return base;
  }

  async listCalls(auth: AuthContext, filters: CallFilters): Promise<CallListRow[]> {
    const take = Math.min(Number(filters.limit ?? 100) || 100, 200);
    const q = filters.q?.trim();

    const leadWhere: Record<string, unknown> = {
      ...this.leadScope(auth),
      ...(filters.temperature ? { temperature: filters.temperature } : {}),
      ...(q
        ? {
            OR: [
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { normalized_phone: { contains: q } },
            ],
          }
        : {}),
      ...(filters.agentId
        ? { lead_assignments: { some: { agent_id: filters.agentId, is_current: true } } }
        : {}),
    };

    const org = auth.organizationId;
    // One lead's calls and no other filter is the lead detail view's request:
    // one statement, see callsForLead. Everything else keeps the general path.
    const leadOnly = filters.leadId && !q && !filters.temperature && !filters.agentId && !filters.from && !filters.to;
    const rows = leadOnly
      ? await this.callsForLead(auth, filters.leadId!, take)
      : await this.withLeadsAndAgents(
          org,
          // The calls first; then their leads and current agents in one
          // parallel round. A nested include loads each level as its own
          // sequential query.
          await this.prisma.voice_calls.findMany({
            where: {
              organization_id: org,
              ...(filters.leadId ? { lead_id: filters.leadId } : {}),
              ...(filters.from || filters.to
                ? {
                    created_at: {
                      ...(filters.from ? { gte: new Date(filters.from) } : {}),
                      ...(filters.to ? { lte: new Date(filters.to) } : {}),
                    },
                  }
                : {}),
              ...(Object.keys(leadWhere).length ? { leads: leadWhere } : {}),
            },
            orderBy: { created_at: 'desc' },
            take,
          }),
        );

    // Which call is the newest for its lead, so only that one may carry a
    // relationship-level outcome like APPOINTMENT_BOOKED.
    const latestSeen = new Set<string>();
    const isLatest = new Map<string, boolean>();
    for (const r of rows) {
      const first = !latestSeen.has(r.lead_id);
      latestSeen.add(r.lead_id);
      isLatest.set(r.id, first);
    }

    const mapped = rows.map((r) => this.toListRow(r, isLatest.get(r.id) ?? false));

    // Outcome is derived, not stored, so it cannot be filtered in SQL without
    // duplicating the rules above in two places. The page size is capped at
    // 200, so doing it here costs nothing and keeps one definition.
    return filters.outcome ? mapped.filter((c) => c.outcome === filters.outcome) : mapped;
  }

  /**
   * Attaches each call's lead and that lead's current agent, in the shape
   * toListRow reads (`leads.lead_assignments[0].agent_profiles.users`).
   *
   * Two reads in parallel instead of a four-level include. The agent comes
   * from one joined row per lead — DISTINCT ON, like the old `take: 1` — so an
   * agent's id and name can never come from different assignments. Every table
   * in the join is pinned to the caller's organization.
   */
  /**
   * One lead's calls with that lead and its current agent, in ONE statement:
   * the same rows the general path's call query and withLeadsAndAgents return
   * together over two sequential round trips, in the same shape.
   *
   * Same scoping: the session's organization on the call, the lead and the
   * assignment, and for an agent only a lead currently assigned to them —
   * leadScope, in SQL; keep the two in step. Newest first, `take` at most.
   *
   * The transcript itself is not read: a list row only says whether there is
   * one, so `transcript` here carries that answer, which is all toListRow reads
   * of it (`!!r.transcript`). The text stays with getCall.
   */
  private async callsForLead(auth: AuthContext, leadId: string, take: number) {
    const org = auth.organizationId;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        lead_id: string;
        provider: string;
        provider_call_id: string | null;
        direction: string;
        status: string;
        handoff_requested: boolean;
        dnc_detected: boolean;
        duration_seconds: number | null;
        recording_url: string | null;
        has_transcript: boolean;
        started_at: Date | null;
        ended_at: Date | null;
        created_at: Date;
        lead_found: string | null;
        first_name: string | null;
        last_name: string | null;
        phone: string | null;
        temperature: string | null;
        lead_status: string | null;
        agent_id: string | null;
        agent_first_name: string | null;
        agent_last_name: string | null;
        agent_email: string | null;
      }>
    >`
      select c.id, c.lead_id, c.provider, c.provider_call_id, c.direction, c.status,
             c.handoff_requested, c.dnc_detected, c.duration_seconds, c.recording_url,
             (c.transcript is not null and c.transcript <> '') as has_transcript,
             c.started_at, c.ended_at, c.created_at,
             l.id as lead_found, l.first_name, l.last_name, l.phone, l.temperature, l.status as lead_status,
             agent.agent_id, agent.first_name as agent_first_name, agent.last_name as agent_last_name,
             agent.email as agent_email
        from voice_calls c
        left join leads l on l.id = c.lead_id and l.organization_id = c.organization_id
        left join lateral (
          select a.agent_id, u.first_name, u.last_name, u.email
            from lead_assignments a
            join agent_profiles ap on ap.id = a.agent_id and ap.organization_id = ${org}::uuid
            join users u on u.id = ap.user_id
           where a.organization_id = ${org}::uuid and a.is_current and a.lead_id = l.id
           limit 1
        ) agent on true
       where c.organization_id = ${org}::uuid and c.lead_id = ${leadId}::uuid
             ${
               auth.role === 'owner'
                 ? Prisma.empty
                 : Prisma.sql`and exists (
                     select 1 from lead_assignments mine
                      where mine.organization_id = c.organization_id and mine.lead_id = c.lead_id
                        and mine.agent_id = ${auth.agentProfileId ?? ''}::uuid and mine.is_current
                   )`
             }
       order by c.created_at desc
       limit ${take}
    `;

    return rows.map((r) => ({
      id: r.id,
      lead_id: r.lead_id,
      provider: r.provider,
      provider_call_id: r.provider_call_id,
      direction: r.direction,
      status: r.status,
      handoff_requested: r.handoff_requested,
      dnc_detected: r.dnc_detected,
      duration_seconds: r.duration_seconds,
      recording_url: r.recording_url,
      transcript: r.has_transcript,
      started_at: r.started_at,
      ended_at: r.ended_at,
      created_at: r.created_at,
      leads: r.lead_found
        ? {
            first_name: r.first_name,
            last_name: r.last_name,
            phone: r.phone,
            temperature: r.temperature,
            status: r.lead_status!,
            lead_assignments: r.agent_id
              ? [
                  {
                    agent_id: r.agent_id,
                    agent_profiles: {
                      users: { first_name: r.agent_first_name, last_name: r.agent_last_name, email: r.agent_email! },
                    },
                  },
                ]
              : [],
          }
        : null,
    }));
  }

  private async withLeadsAndAgents<T extends { lead_id: string }>(org: string, calls: T[]) {
    const leadIds = [...new Set(calls.map((c) => c.lead_id))];
    const [leads, agents] = leadIds.length
      ? await Promise.all([
          this.prisma.leads.findMany({
            where: { organization_id: org, id: { in: leadIds } },
            select: { id: true, first_name: true, last_name: true, phone: true, temperature: true, status: true },
          }),
          this.prisma.$queryRaw<
            { lead_id: string; agent_id: string; first_name: string | null; last_name: string | null; email: string }[]
          >`
            select distinct on (a.lead_id) a.lead_id, a.agent_id, u.first_name, u.last_name, u.email
              from lead_assignments a
              join agent_profiles ap on ap.id = a.agent_id and ap.organization_id = ${org}::uuid
              join users u on u.id = ap.user_id
             where a.organization_id = ${org}::uuid
               and a.is_current
               and a.lead_id = any(${leadIds}::uuid[])`,
        ])
      : [[], []];

    const agentByLead = new Map(agents.map((a) => [a.lead_id, a]));
    const leadById = new Map(
      leads.map((l) => {
        const a = agentByLead.get(l.id);
        const lead_assignments = a
          ? [{ agent_id: a.agent_id, agent_profiles: { users: { first_name: a.first_name, last_name: a.last_name, email: a.email } } }]
          : [];
        return [l.id, { ...l, lead_assignments }];
      }),
    );
    return calls.map((c) => ({ ...c, leads: leadById.get(c.lead_id) ?? null }));
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private toListRow(r: any, isLatest: boolean): CallListRow {
    const lead = r.leads;
    const assignment = lead?.lead_assignments?.[0];
    const agentUser = assignment?.agent_profiles?.users;

    const base = HistoryService.outcomeOf(r);
    return {
      id: r.id,
      leadId: r.lead_id,
      leadName: fullName(lead?.first_name ?? null, lead?.last_name ?? null, 'Unknown lead'),
      leadPhone: lead?.phone ?? null,
      temperature: lead?.temperature ?? null,
      provider: r.provider,
      providerCallId: r.provider_call_id,
      direction: r.direction,
      status: r.status,
      outcome: HistoryService.withLeadOutcome(base, lead?.status ?? '', isLatest),
      durationSeconds: r.duration_seconds,
      recordingUrl: r.recording_url,
      hasTranscript: !!r.transcript,
      startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at),
      createdAt: r.created_at.toISOString(),
      agentId: assignment?.agent_id ?? null,
      agentName: agentUser
        ? fullName(agentUser.first_name, agentUser.last_name, agentUser.email)
        : null,
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * One call with its transcript.
   *
   * Separate from the list on purpose: a transcript is a few kilobytes, and
   * shipping two hundred of them to render a list nobody has expanded yet is
   * the difference between a page that loads and one that does not.
   */
  async getCall(auth: AuthContext, id: string): Promise<CallDetail> {
    const org = auth.organizationId;
    // "The lead that owns this call", reached through the call id so the three
    // reads below can run together instead of waiting on each other. Every one
    // is scoped to the caller's organization.
    const ownsCall = { voice_calls: { some: { id, organization_id: org } } };

    const [call, lead, agent, latest] = await Promise.all([
      // Visibility is decided here, exactly as before: an agent only sees calls
      // on leads currently assigned to them. The other two reads only enrich a
      // call that passed this check, and are discarded otherwise.
      this.prisma.voice_calls.findFirst({
        where: {
          id,
          organization_id: org,
          ...(auth.role === 'owner' ? {} : { leads: this.leadScope(auth) }),
        },
      }),
      this.prisma.leads.findFirst({
        where: { organization_id: org, ...ownsCall },
        select: { id: true, first_name: true, last_name: true, phone: true, temperature: true, status: true },
      }),
      // The lead's current agent, as its own read so it does not wait on the
      // lead: one profile row with its user, so the id and the name always come
      // from the same assignment (what `lead_assignments: take 1` returned).
      this.prisma.agent_profiles.findFirst({
        where: {
          organization_id: org,
          lead_assignments: { some: { organization_id: org, is_current: true, leads: ownsCall } },
        },
        select: { id: true, users: { select: { first_name: true, last_name: true, email: true } } },
      }),
      // A single call fetched by id is always treated as the lead's latest for
      // outcome purposes: the caller asked about this call specifically.
      this.prisma.voice_calls.findFirst({
        where: { organization_id: org, leads: ownsCall },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      }),
    ]);
    if (!call) throw new AppError('NOT_FOUND', 'No such call');
    // Reassembled into the shape toListRow has always read.
    const r = {
      ...call,
      leads: lead && {
        ...lead,
        lead_assignments: agent ? [{ agent_id: agent.id, agent_profiles: { users: agent.users } }] : [],
      },
    };

    return {
      ...this.toListRow(r, latest?.id === r.id),
      transcript: r.transcript,
      aiSummary: r.ai_summary,
      extractedIntel: r.extracted_intel,
      handoffRequested: r.handoff_requested,
      dncDetected: r.dnc_detected,
    };
  }

  /** Every SMS thread in the office, most recently active first. */
  async listConversations(auth: AuthContext, limitRaw?: string, leadId?: string): Promise<ConversationRow[]> {
    const take = Math.min(Number(limitRaw ?? 100) || 100, 200);
    const leadWhere = this.leadScope(auth);

    const org = auth.organizationId;
    // Threads first (the message count rides along in the same query), then
    // everything that hangs off them in one parallel round: Prisma loads each
    // included relation as its own sequential query, and on a remote database
    // every one of those is a full round trip.
    const threads = await this.prisma.conversations.findMany({
      where: {
        organization_id: org,
        // Narrows within the org and the agent's visibility below; a lead the
        // caller cannot see simply yields no threads.
        ...(leadId ? { lead_id: leadId } : {}),
        ...(Object.keys(leadWhere).length ? { leads: leadWhere } : {}),
      },
      orderBy: { updated_at: 'desc' },
      take,
      include: { _count: { select: { messages: true } } },
    });
    const ids = threads.map((r) => r.id);
    const leadIds = [...new Set(threads.map((r) => r.lead_id))];

    const [leadRows, lastMessages, inbound] = ids.length
      ? await Promise.all([
          this.prisma.leads.findMany({
            where: { organization_id: org, id: { in: leadIds } },
            select: { id: true, first_name: true, last_name: true, phone: true, temperature: true, dnc_status: true },
          }),
          // The newest message per thread — what `messages: { orderBy: created_at
          // desc, take: 1 }` returned per conversation, as one statement.
          this.prisma.$queryRaw<{ conversation_id: string; body: string; direction: string; created_at: Date }[]>`
            select distinct on (conversation_id) conversation_id, body, direction, created_at
              from messages
             where organization_id = ${org}::uuid
               and conversation_id = any(${ids}::uuid[])
             order by conversation_id, created_at desc`,
          // "Has the lead ever replied" in one grouped query rather than one per
          // thread: it is the flag the UI sorts its attention by, so it must not
          // cost N round trips.
          this.prisma.messages.groupBy({
            by: ['conversation_id'],
            where: { organization_id: org, direction: 'inbound', conversation_id: { in: ids } },
          }),
        ])
      : [[], [], []];

    const leadsById = new Map(leadRows.map((l) => [l.id, l]));
    const lastByThread = new Map(lastMessages.map((m) => [m.conversation_id, m]));
    const withInbound = new Set(inbound.map((g) => g.conversation_id));
    const rows = threads.map((t) => ({ ...t, leads: leadsById.get(t.lead_id) ?? null }));

    return rows.map((r) => {
      const last = lastByThread.get(r.id);
      return {
        id: r.id,
        leadId: r.lead_id,
        leadName: fullName(r.leads?.first_name ?? null, r.leads?.last_name ?? null, 'Unknown lead'),
        leadPhone: r.leads?.phone ?? null,
        temperature: r.leads?.temperature ?? null,
        status: r.status,
        channel: r.channel,
        messageCount: r._count.messages,
        lastMessageAt: last ? last.created_at.toISOString() : null,
        lastMessageBody: last?.body ?? null,
        lastMessageDirection: last?.direction ?? null,
        hasInboundReply: withInbound.has(r.id),
        dncStatus: !!r.leads?.dnc_status,
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /** One thread, oldest first — the order a conversation is read in. */
  async listMessages(auth: AuthContext, conversationId: string): Promise<MessageRow[]> {
    const conv = await this.prisma.conversations.findFirst({
      where: {
        id: conversationId,
        organization_id: auth.organizationId,
        ...(auth.role === 'owner' ? {} : { leads: this.leadScope(auth) }),
      },
      select: { id: true },
    });
    if (!conv) throw new AppError('NOT_FOUND', 'No such conversation');

    const rows = await this.prisma.messages.findMany({
      where: { organization_id: auth.organizationId, conversation_id: conv.id },
      orderBy: { created_at: 'asc' },
      take: 500,
    });

    return rows.map(toMessageRow);
  }

  /**
   * Every message in one lead's SMS threads — what the lead detail view shows —
   * exactly as the thread list plus listMessages per SMS thread return them
   * together: the lead's threads in the thread list's order (latest activity
   * first, the same 200 cap), the SMS ones only, each thread's messages oldest
   * first up to the same 500. ONE statement where the view made 2 + N requests.
   *
   * Visibility is the thread list's: the session's organization, and for an
   * agent only a lead currently assigned to them — leadScope, in SQL; keep the
   * two in step. A lead the caller cannot see has no threads, so the answer is
   * an empty list, as the thread list's was.
   */
  async listLeadMessages(auth: AuthContext, leadId: string): Promise<MessageRow[]> {
    const org = auth.organizationId;
    const rows = await this.prisma.$queryRaw<Parameters<typeof toMessageRow>[0][]>`
      select m.id, m.direction, m.sender_type, m.channel, m.body, m.delivery_status,
             m.sent_at, m.delivered_at, m.failed_at, m.created_at
        from (
          select c.id, c.channel, row_number() over (order by c.updated_at desc) as position
            from conversations c
           where c.organization_id = ${org}::uuid and c.lead_id = ${leadId}::uuid
                 ${
                   auth.role === 'owner'
                     ? Prisma.empty
                     : Prisma.sql`and exists (
                         select 1 from lead_assignments la
                          where la.organization_id = c.organization_id and la.lead_id = c.lead_id
                            and la.agent_id = ${auth.agentProfileId ?? ''}::uuid and la.is_current
                       )`
                 }
           order by c.updated_at desc
           limit 200
        ) t
        cross join lateral (
          select * from messages m
           where m.organization_id = ${org}::uuid and m.conversation_id = t.id
           order by m.created_at asc
           limit 500
        ) m
       where t.channel = 'sms'
       order by t.position, m.created_at asc
    `;

    return rows.map(toMessageRow);
  }
}

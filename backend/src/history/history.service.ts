import { Injectable } from '@nestjs/common';
import { Prisma, type Call, type LeadStatus, type Message } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { canReadAllLeads, fullName, visibleLeads } from '@/lead/lead-scope';
import { ActivityService } from '@/telnyx/activity.service';
import type { CallFiltersQuery } from './dto/history.query';

export type CallOutcome =
  | 'ANSWERED'
  | 'NO_ANSWER'
  | 'QUALIFIED'
  | 'APPOINTMENT_BOOKED'
  | 'HUMAN_HANDOFF'
  | 'NOT_INTERESTED'
  | 'FAILED'
  | 'IN_PROGRESS';

const CALL_LEAD = {
  select: {
    firstName: true,
    lastName: true,
    phone: true,
    temperature: true,
    status: true,
    assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
  },
} as const;

type CallRow = Call & { lead: Prisma.LeadGetPayload<typeof CALL_LEAD> | null };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function outcomeOf(call: Pick<Call, 'status' | 'handoffRequested' | 'dncDetected'>): CallOutcome {
  if (call.dncDetected) return 'NOT_INTERESTED';
  if (call.handoffRequested) return 'HUMAN_HANDOFF';
  switch (call.status) {
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

/** The lead's own status speaks for its latest call: the booking or qualification it led to. */
function withLeadOutcome(base: CallOutcome, leadStatus: LeadStatus | undefined, isLatest: boolean): CallOutcome {
  if (!isLatest || base === 'NOT_INTERESTED' || base === 'HUMAN_HANDOFF') return base;
  if (leadStatus === 'appointment_booked') return 'APPOINTMENT_BOOKED';
  if (leadStatus === 'interested' || leadStatus === 'appointment_requested') return 'QUALIFIED';
  if (leadStatus === 'not_interested') return 'NOT_INTERESTED';
  return base;
}

const toMessageRow = (m: Message) => ({
  id: m.id,
  direction: m.direction,
  senderType: m.senderType,
  channel: m.channel,
  body: m.body,
  deliveryStatus: m.deliveryStatus,
  sentAt: iso(m.sentAt),
  deliveredAt: iso(m.deliveredAt),
  failedAt: iso(m.failedAt),
  createdAt: m.createdAt.toISOString(),
});

/** Calls and text threads. Anyone without lead.read sees only those of the leads assigned to them. */
@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async listCalls(auth: AuthContext, f: CallFiltersQuery) {
    const q = f.q?.trim();
    const leadWhere: Prisma.LeadWhereInput = {
      ...visibleLeads(auth),
      ...(f.temperature ? { temperature: f.temperature } : {}),
      ...(f.agentId ? { assignedToId: f.agentId } : {}),
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { normalizedPhone: { contains: q } },
            ],
          }
        : {}),
    };
    const rows: CallRow[] = await this.prisma.call.findMany({
      where: {
        orgId: auth.organizationId,
        ...(f.leadId ? { leadId: f.leadId } : {}),
        ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
        lead: leadWhere,
      },
      orderBy: { createdAt: 'desc' },
      take: f.limit ?? 100,
      include: { lead: CALL_LEAD },
    });
    const seen = new Set<string>();
    const mapped = rows.map((r) => {
      const isLatest = !seen.has(r.leadId);
      seen.add(r.leadId);
      return this.toListRow(r, isLatest);
    });
    return f.outcome ? mapped.filter((c) => c.outcome === f.outcome) : mapped;
  }

  async getCall(auth: AuthContext, id: string) {
    const call = await this.prisma.call.findFirst({
      where: { id, orgId: auth.organizationId, lead: visibleLeads(auth) },
      include: { lead: CALL_LEAD },
    });
    if (!call) throw new AppError('NOT_FOUND', 'No such call');
    const latest = await this.prisma.call.findFirst({
      where: { orgId: auth.organizationId, leadId: call.leadId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const row = this.toListRow(call, latest?.id === call.id);
    if (row.recordingUrl && call.provider === 'telnyx' && call.providerCallId) {
      row.recordingUrl = (await this.activity.freshRecordingUrl(auth.organizationId, call.providerCallId)) ?? row.recordingUrl;
    }
    return {
      ...row,
      transcript: labelSpeakers(call.transcript, call.lead?.firstName ?? null, call.provider),
      aiSummary: call.aiSummary,
      extractedIntel: call.extractedIntel,
      handoffRequested: call.handoffRequested,
      dncDetected: call.dncDetected,
    };
  }

  /** One thread per lead that has texted or been texted; the thread's id is the lead's. */
  async listConversations(auth: AuthContext, limit = 100, leadId?: string) {
    const scope = canReadAllLeads(auth) ? Prisma.empty : Prisma.sql`AND l.assigned_to_id = ${auth.userId}::uuid`;
    const rows = await this.prisma.$queryRaw<
      {
        lead_id: string;
        first_name: string | null;
        last_name: string | null;
        phone: string | null;
        temperature: string | null;
        dnc_status: boolean;
        message_count: number;
        has_inbound: boolean;
        first_at: Date;
        last_at: Date;
        last_body: string;
        last_direction: string;
      }[]
    >`
      SELECT m.lead_id, l.first_name, l.last_name, l.phone, l.temperature::text AS temperature, l.dnc_status,
             count(*)::int AS message_count,
             bool_or(m.direction = 'inbound') AS has_inbound,
             min(m.created_at) AS first_at,
             max(m.created_at) AS last_at,
             (array_agg(m.body ORDER BY m.created_at DESC))[1] AS last_body,
             (array_agg(m.direction::text ORDER BY m.created_at DESC))[1] AS last_direction
        FROM messages m
        JOIN leads l ON l.id = m.lead_id AND l.organization_id = m.organization_id
       WHERE m.organization_id = ${auth.organizationId}::uuid AND m.channel = 'sms'
             ${leadId ? Prisma.sql`AND m.lead_id = ${leadId}::uuid` : Prisma.empty}
             ${scope}
       GROUP BY m.lead_id, l.id
       ORDER BY last_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 200)}`;
    return rows.map((r) => ({
      id: r.lead_id,
      leadId: r.lead_id,
      leadName: fullName(r.first_name, r.last_name, 'Unknown lead'),
      leadPhone: r.phone,
      temperature: r.temperature,
      status: 'active',
      channel: 'sms',
      messageCount: r.message_count,
      lastMessageAt: r.last_at.toISOString(),
      lastMessageBody: r.last_body,
      lastMessageDirection: r.last_direction,
      hasInboundReply: r.has_inbound,
      dncStatus: r.dnc_status,
      createdAt: r.first_at.toISOString(),
    }));
  }

  async listMessages(auth: AuthContext, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, ...visibleLeads(auth) }, select: { id: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such conversation');
    const rows = await this.prisma.message.findMany({
      where: { orgId: auth.organizationId, leadId, channel: 'sms' },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return rows.map(toMessageRow);
  }

  private toListRow(r: CallRow, isLatest: boolean) {
    const agent = r.lead?.assignedTo;
    return {
      id: r.id,
      leadId: r.leadId,
      leadName: fullName(r.lead?.firstName, r.lead?.lastName, 'Unknown lead'),
      leadPhone: r.lead?.phone ?? null,
      temperature: r.lead?.temperature ?? null,
      provider: r.provider,
      providerCallId: r.providerCallId,
      direction: r.direction,
      status: r.status,
      outcome: withLeadOutcome(outcomeOf(r), r.lead?.status, isLatest),
      durationSeconds: r.durationSeconds,
      recordingUrl: r.recordingUrl,
      hasTranscript: Boolean(r.transcript),
      startedAt: iso(r.startedAt),
      endedAt: iso(r.endedAt),
      createdAt: r.createdAt.toISOString(),
      agentId: agent?.id ?? null,
      agentName: agent ? fullName(agent.firstName, agent.lastName, agent.email) : null,
    };
  }
}

/**
 * Telnyx labels speakers by recording channel; channel 1 is the lead, channel 2 the assistant.
 * Retell writes "User:" for the lead and "Agent:" for its agent.
 */
export function labelSpeakers(transcript: string | null, leadFirstName: string | null, provider = 'telnyx'): string | null {
  if (!transcript) return transcript;
  const lead = leadFirstName?.trim() || 'User';
  if (provider === 'retell') return transcript.replace(/^\s*user\s*:/gim, `${lead}:`).replace(/^\s*agent\s*:/gim, 'Assistant:');
  return transcript.replace(/^\s*channel\s*1\s*:/gim, `${lead}:`).replace(/^\s*channel\s*2\s*:/gim, 'Assistant:');
}

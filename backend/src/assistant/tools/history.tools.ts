import { z } from 'zod';
import type { GuardedPrisma } from '@/common/prisma/prisma.service';
import { CALL_OUTCOMES } from '@/history/dto/history.query';
import type { HistoryService } from '@/history/history.service';
import { callRef, leadRef, type RefTable } from './refs';
import { readTool, type AssistantTool } from './tool';

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGES = 40;

interface CallRow {
  id: string;
  leadId: string;
  agentId: string | null;
  recordingUrl: string | null;
  provider: string;
  providerCallId: string | null;
}

/** Ids become refs; the recording link and the provider's own ids stay on our side. */
async function shapeCalls<T extends CallRow>(refs: RefTable, calls: T[]) {
  const [callRefs, leadRefs, userRefs] = await Promise.all([
    refs.issue('call', calls.map((c) => c.id)),
    refs.issue('lead', calls.map((c) => c.leadId)),
    refs.issue('user', calls.flatMap((c) => (c.agentId ? [c.agentId] : []))),
  ]);
  return calls.map(({ id, leadId, agentId, recordingUrl: _url, provider: _provider, providerCallId: _providerId, ...call }) => ({
    ref: callRefs.get(id)!,
    leadRef: leadRefs.get(leadId)!,
    agentRef: agentId ? userRefs.get(agentId)! : null,
    ...call,
  }));
}

export function historyTools(history: HistoryService, prisma: GuardedPrisma): AssistantTool[] {
  return [
    readTool({
      name: 'call_list',
      label: 'Looking up calls',
      description: 'Recent AI calls, newest first, optionally for one lead, one outcome or a date range.',
      permissions: [],
      input: z
        .object({
          lead: leadRef.optional(),
          outcome: z.enum(CALL_OUTCOMES).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .strict(),
      async run({ auth, refs }, { lead, ...input }) {
        const calls = await history.listCalls(auth, {
          ...input,
          leadId: lead ? await refs.resolve('lead', lead) : undefined,
          from: input.from ? new Date(input.from) : undefined,
          to: input.to ? new Date(input.to) : undefined,
        });
        return shapeCalls(refs, calls);
      },
    }),

    readTool({
      name: 'call_get',
      label: 'Reading the call',
      description: 'One call in full: outcome, AI summary, what was learned, and the transcript.',
      permissions: [],
      input: z.object({ call: callRef }).strict(),
      async run({ auth, refs }, input) {
        const { transcript, ...call } = await history.getCall(auth, await refs.resolve('call', input.call));
        const [shaped] = await shapeCalls(refs, [call]);
        return {
          ...shaped,
          transcript: transcript && transcript.length > MAX_TRANSCRIPT_CHARS ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}… (truncated)` : transcript,
        };
      },
    }),

    readTool({
      name: 'lead_timeline',
      label: 'Reading the timeline',
      description:
        "What happened on a lead, newest first: status changes and why, outreach steps sent, held or skipped, callbacks, takeovers and meetings. Calls and texts themselves are in call_list and lead_messages.",
      permissions: [],
      input: z.object({ lead: leadRef, limit: z.number().int().min(1).max(100).default(30) }).strict(),
      async run({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        const events = await prisma.leadEvent.findMany({
          where: { leadId, orgId: auth.organizationId },
          orderBy: { createdAt: 'desc' },
          take: input.limit,
          select: { type: true, fromStatus: true, toStatus: true, reason: true, channel: true, source: true, actorType: true, actorId: true, callId: true, createdAt: true },
        });
        const [userRefs, callRefs] = await Promise.all([
          refs.issue('user', events.flatMap((e) => (e.actorType === 'user' && e.actorId ? [e.actorId] : []))),
          refs.issue('call', events.flatMap((e) => (e.callId ? [e.callId] : []))),
        ]);
        return events.map((e) => ({
          at: e.createdAt,
          event: e.type,
          ...(e.fromStatus || e.toStatus ? { status: { from: e.fromStatus, to: e.toStatus } } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
          ...(e.channel ? { channel: e.channel } : {}),
          by: e.actorType === 'user' && e.actorId ? userRefs.get(e.actorId)! : e.actorType,
          source: e.source,
          ...(e.callId ? { call: callRefs.get(e.callId)! } : {}),
        }));
      },
    }),

    readTool({
      name: 'lead_messages',
      label: 'Reading the text thread',
      description: `The SMS thread with one lead, latest ${MAX_MESSAGES} messages.`,
      permissions: [],
      input: z.object({ lead: leadRef }).strict(),
      async run({ auth, refs }, input) {
        const thread = await history.listMessages(auth, await refs.resolve('lead', input.lead));
        return thread.slice(-MAX_MESSAGES).map(({ id: _id, ...message }) => message);
      },
    }),
  ];
}

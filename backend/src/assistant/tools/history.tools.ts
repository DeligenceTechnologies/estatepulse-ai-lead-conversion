import { z } from 'zod';
import { CALL_OUTCOMES } from '@/history/dto/history.query';
import type { HistoryService } from '@/history/history.service';
import { readTool, type AssistantTool } from './tool';

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGES = 40;

export function historyTools(history: HistoryService): AssistantTool[] {
  return [
    readTool({
      name: 'call_list',
      label: 'Looking up calls',
      description: 'Recent AI calls, newest first, optionally for one lead, one outcome or a date range.',
      permissions: [],
      input: z
        .object({
          leadId: z.uuid().optional(),
          outcome: z.enum(CALL_OUTCOMES).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .strict(),
      async run({ auth }, input) {
        const calls = await history.listCalls(auth, {
          ...input,
          from: input.from ? new Date(input.from) : undefined,
          to: input.to ? new Date(input.to) : undefined,
        });
        return calls.map(({ recordingUrl: _url, provider: _provider, providerCallId: _id, ...call }) => call);
      },
    }),

    readTool({
      name: 'call_get',
      label: 'Reading the call',
      description: 'One call in full: outcome, AI summary, what was learned, and the transcript.',
      permissions: [],
      input: z.object({ callId: z.uuid() }).strict(),
      async run({ auth }, input) {
        const { recordingUrl: _url, provider: _provider, providerCallId: _id, transcript, ...call } = await history.getCall(auth, input.callId);
        return {
          ...call,
          transcript: transcript && transcript.length > MAX_TRANSCRIPT_CHARS ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}… (truncated)` : transcript,
        };
      },
    }),

    readTool({
      name: 'lead_messages',
      label: 'Reading the text thread',
      description: `The SMS thread with one lead, latest ${MAX_MESSAGES} messages.`,
      permissions: [],
      input: z.object({ leadId: z.uuid() }).strict(),
      async run({ auth }, input) {
        const thread = await history.listMessages(auth, input.leadId);
        return thread.slice(-MAX_MESSAGES);
      },
    }),
  ];
}

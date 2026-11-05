import { describe, expect, it } from 'vitest';
import { ActivityService } from './activity.service';

/** onTranscriptionSaved needs the call row and nothing else the service is built with. */
const service = (transcript: string | null, written: string[]): ActivityService => {
  const prisma = {
    call: {
      findFirst: async () => ({ id: 'call-1', orgId: 'org-1', leadId: 'lead-1', transcript }),
      update: async ({ data }: { data: { transcript: string } }) => void written.push(data.transcript),
    },
  };
  const rest = Array(9).fill({}) as [any, any, any, any, any, any, any, any, any];
  return new ActivityService(prisma as any, ...rest);
};

const saved = async (transcript: string | null, text: string): Promise<string[]> => {
  const written: string[] = [];
  await service(transcript, written).onTranscriptionSaved('ccid-1', { transcription_text: text });
  return written;
};

describe('a transcript passage is stitched on once', () => {
  it('writes the first passage as the transcript', async () => {
    expect(await saved(null, 'Hi, is this Dana?')).toEqual(['Hi, is this Dana?']);
  });

  it('adds a later passage on its own line', async () => {
    expect(await saved('Hi, is this Dana?', 'It is, yes.')).toEqual(['Hi, is this Dana?\nIt is, yes.']);
  });

  it('ignores the same event again — a Telnyx retry, or a captured one replayed', async () => {
    expect(await saved('Hi, is this Dana?\nIt is, yes.', 'It is, yes.')).toEqual([]);
  });
});

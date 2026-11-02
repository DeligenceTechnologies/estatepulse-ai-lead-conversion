import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadMemoryService } from './lead-memory.service';
import type { Extraction } from './lead-scoring';
import { normalizeQuestions } from './qualification';

const questions = normalizeQuestions([
  { key: 'property_type', label: 'Property type', question: 'Plot or flat?', type: 'choice', options: ['Plot', 'Flat'], enabled: true },
  { key: 'location', label: 'Location', question: 'Which area?', type: 'text', enabled: true },
]);

const at = (min: number) => new Date(Date.UTC(2026, 9, 28, 10, min));

type Text = { id: string; direction: 'inbound' | 'outbound'; body: string; createdAt: Date };

const extraction = (over: Partial<Extraction> = {}): Extraction =>
  ({
    timeline: 'unknown',
    budget_identified: false,
    location_identified: false,
    pre_approved: false,
    appointment_requested: false,
    high_engagement: false,
    not_interested: false,
    invalid_lead: false,
    human_requested: false,
    summary: 'A short call.',
    ...over,
  }) as Extraction;

function setup(
  opts: {
    lead?: Record<string, unknown> | null;
    texts?: Text[];
    chat?: Partial<Extraction>;
    note?: string | (() => Promise<string>);
  } = {},
) {
  const lead = opts.lead === null ? null : { memoryUpdatedAt: null, memorySummary: 'Wants a quiet street.', qualificationAnswers: {}, ...opts.lead };
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => lead),
      update: vi.fn(async () => ({})),
    },
    message: { findMany: vi.fn(async () => [...(opts.texts ?? [])].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) },
  };
  const insights = {
    extractFromChat: vi.fn(async () => extraction({ location: 'Noida', answers: { property_type: 'flat' }, ...opts.chat })),
    rewriteMemory: vi.fn(typeof opts.note === 'function' ? opts.note : async () => opts.note ?? 'Wants a quiet street. Prefers texts after 6pm.'),
  };
  const service = new LeadMemoryService(prisma as any, insights as any, { get: vi.fn(async () => questions) } as any);
  const updates = () => prisma.lead.update.mock.calls.map((c: any[]) => c[0].data);
  return { service, prisma, insights, updates };
}

const CALL = {
  id: 'call-1',
  orgId: 'org-1',
  leadId: 'lead-1',
  transcript: 'Assistant: Plot or flat?\nCaller: A flat, near the metro.',
  createdAt: at(30),
} as any;

describe('lead memory after a call', () => {
  it('stores the answers, dated by the call, and rewrites the note from the transcript', async () => {
    const s = setup();
    await s.service.afterCall(CALL, extraction({ answers: { property_type: 'Flat' } }));

    expect(s.updates()).toContainEqual({ qualificationAnswers: { property_type: { value: 'Flat', at: at(30).toISOString(), source: 'call', refId: 'call-1' } } });
    expect(s.insights.rewriteMemory).toHaveBeenCalledWith('org-1', 'Wants a quiet street.', CALL.transcript);
    expect(s.updates()).toContainEqual({ memorySummary: 'Wants a quiet street. Prefers texts after 6pm.', memoryUpdatedAt: expect.any(Date) });
  });

  it('writes the note from the call summary when there is no transcript', async () => {
    const s = setup();
    await s.service.afterCall({ ...CALL, transcript: null }, extraction({ summary: 'Wants a flat near the metro.' }));
    expect(s.insights.rewriteMemory).toHaveBeenCalledWith('org-1', 'Wants a quiet street.', 'Wants a flat near the metro.');
  });

  it('leaves the answers alone when the call answered none of the questions', async () => {
    const s = setup();
    await s.service.afterCall(CALL, extraction({ answers: { property_type: null } }));
    expect(s.updates().some((d) => 'qualificationAnswers' in d)).toBe(false);
  });

  it('keeps an answer a person entered', async () => {
    const s = setup({ lead: { qualificationAnswers: { property_type: { value: 'Plot', at: at(1).toISOString(), source: 'manual' } } } });
    await s.service.afterCall(CALL, extraction({ answers: { property_type: 'Flat' } }));
    expect(s.updates().some((d) => 'qualificationAnswers' in d)).toBe(false);
  });

  it('clears the note when the AI returns an empty one', async () => {
    const s = setup({ note: '' });
    await s.service.afterCall(CALL, extraction());
    expect(s.updates()).toContainEqual({ memorySummary: null, memoryUpdatedAt: expect.any(Date) });
  });

  it('never fails the scoring when the note cannot be written', async () => {
    const s = setup({ note: async () => Promise.reject(new Error('AI down')) });
    await expect(s.service.afterCall(CALL, extraction({ answers: { property_type: 'Flat' } }))).resolves.toBeUndefined();
    expect(s.updates().some((d) => 'qualificationAnswers' in d)).toBe(true);
  });
});

describe('lead memory from a text chat', () => {
  afterEach(() => vi.useRealTimers());

  it('stores the details, the answers and the rewritten note', async () => {
    const s = setup({
      texts: [
        { id: 'm1', direction: 'outbound', body: 'Plot or flat?', createdAt: at(1) },
        { id: 'm2', direction: 'inbound', body: 'Flat in Noida. Text me after 6pm', createdAt: at(2) },
      ],
    });
    await s.service.readChat('org-1', 'lead-1');

    expect(s.insights.extractFromChat).toHaveBeenCalledWith('org-1', 'Us: Plot or flat?\nLead: Flat in Noida. Text me after 6pm');
    expect(s.updates()).toContainEqual({ location: 'Noida' });
    expect(s.updates()).toContainEqual({ qualificationAnswers: { property_type: { value: 'Flat', at: at(2).toISOString(), source: 'sms', refId: 'm2' } } });
    expect(s.updates()).toContainEqual(expect.objectContaining({ memorySummary: 'Wants a quiet street. Prefers texts after 6pm.' }));
  });

  it('does nothing when the lead sent nothing since the last update', async () => {
    const s = setup({ lead: { memoryUpdatedAt: at(5) }, texts: [{ id: 'm2', direction: 'inbound', body: 'Flat', createdAt: at(2) }] });
    await s.service.readChat('org-1', 'lead-1');
    expect(s.insights.extractFromChat).not.toHaveBeenCalled();
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
  });

  it('does nothing when only we texted since the last update', async () => {
    const s = setup({ lead: { memoryUpdatedAt: at(1) }, texts: [{ id: 'm2', direction: 'outbound', body: 'Still looking?', createdAt: at(3) }] });
    await s.service.readChat('org-1', 'lead-1');
    expect(s.insights.extractFromChat).not.toHaveBeenCalled();
  });

  it('does nothing for a lead that is gone', async () => {
    const s = setup({ lead: null, texts: [{ id: 'm2', direction: 'inbound', body: 'Flat', createdAt: at(2) }] });
    await s.service.readChat('org-1', 'lead-1');
    expect(s.prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('leaves the lead details alone when the chat named none', async () => {
    const s = setup({ texts: [{ id: 'm2', direction: 'inbound', body: 'ok', createdAt: at(2) }], chat: { location: null, answers: {} } });
    await s.service.readChat('org-1', 'lead-1');
    expect(s.updates().every((d) => 'memorySummary' in d)).toBe(true);
  });

  it('reads the whole recent chat, but gives the note only the new texts and a little context', async () => {
    const texts: Text[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      direction: i % 2 ? 'inbound' : 'outbound',
      body: `text ${i}`,
      createdAt: at(i),
    }));
    const s = setup({ lead: { memoryUpdatedAt: at(7) }, texts });
    await s.service.readChat('org-1', 'lead-1');

    expect(String((s.insights.extractFromChat.mock.calls[0] as unknown[])[1]).split('\n')).toHaveLength(10);
    const note = String((s.insights.rewriteMemory.mock.calls[0] as unknown[])[2]);
    expect(note).toBe('Text chat:\nUs: text 4\nLead: text 5\nUs: text 6\nLead: text 7\nUs: text 8\nLead: text 9');
  });

  it('dates a text answer by the newest text from the lead', async () => {
    const s = setup({
      texts: [
        { id: 'm1', direction: 'inbound', body: 'Plot', createdAt: at(1) },
        { id: 'm2', direction: 'inbound', body: 'Sorry, a flat', createdAt: at(4) },
        { id: 'm3', direction: 'outbound', body: 'Got it', createdAt: at(5) },
      ],
    });
    await s.service.readChat('org-1', 'lead-1');
    expect(s.updates()).toContainEqual({ qualificationAnswers: { property_type: expect.objectContaining({ at: at(4).toISOString(), refId: 'm2' }) } });
  });

  it('waits for the chat to go quiet, and a newer text restarts the wait', async () => {
    vi.useFakeTimers();
    const s = setup();
    const read = vi.spyOn(s.service, 'readChat').mockResolvedValue();
    s.service.onLeadText('org-1', 'lead-1', 1000);
    await vi.advanceTimersByTimeAsync(800);
    s.service.onLeadText('org-1', 'lead-1', 1000);
    await vi.advanceTimersByTimeAsync(800);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate wait for each lead', async () => {
    vi.useFakeTimers();
    const s = setup();
    const read = vi.spyOn(s.service, 'readChat').mockResolvedValue();
    s.service.onLeadText('org-1', 'lead-1', 1000);
    s.service.onLeadText('org-1', 'lead-2', 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(read.mock.calls.map((c) => c[1]).sort()).toEqual(['lead-1', 'lead-2']);
  });

  it('logs a failed chat read instead of throwing from the timer', async () => {
    vi.useFakeTimers();
    const s = setup();
    vi.spyOn(s.service, 'readChat').mockRejectedValue(new Error('AI down'));
    s.service.onLeadText('org-1', 'lead-1', 10);
    await expect(vi.advanceTimersByTimeAsync(20)).resolves.not.toThrow();
  });
});

describe('one memory update per lead at a time', () => {
  it('runs a chat read only after the call update for the same lead has finished', async () => {
    const order: string[] = [];
    let release!: () => void;
    const s = setup({
      texts: [{ id: 'm1', direction: 'inbound', body: 'Flat', createdAt: at(40) }],
      note: () => {
        order.push('note:start');
        return order.length === 1 ? new Promise<string>((r) => (release = () => r('call note'))) : Promise.resolve('chat note');
      },
    });
    s.insights.extractFromChat.mockImplementation(async () => {
      order.push('chat:extract');
      return extraction();
    });

    const call = s.service.afterCall(CALL, extraction());
    const chat = (s.service as any).serial('lead-1', () => s.service.readChat('org-1', 'lead-1'));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['note:start']);
    release();
    await Promise.all([call, chat]);
    expect(order).toEqual(['note:start', 'chat:extract', 'note:start']);
  });

  it('still runs the next update after one fails', async () => {
    const s = setup();
    const first = (s.service as any).serial('lead-1', async () => Promise.reject(new Error('boom')));
    const second = vi.fn(async () => undefined);
    await expect(first).rejects.toThrow('boom');
    await (s.service as any).serial('lead-1', second);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

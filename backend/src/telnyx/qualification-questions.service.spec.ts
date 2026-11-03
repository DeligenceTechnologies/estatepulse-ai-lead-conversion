import { describe, expect, it, vi } from 'vitest';
import { QualificationQuestionsService } from './qualification-questions.service';

const SAVED = [
  { key: 'property_type', label: 'Property type', question: 'Plot or flat?', type: 'choice', options: ['Plot', 'Flat'], enabled: true },
  { key: 'family', label: 'Family', question: 'How many family members?', type: 'number', enabled: true },
  { key: 'location', label: 'Location', question: 'Which area?', enabled: true },
];

function setup(lead: Record<string, unknown> | null = {}, saved: unknown = SAVED) {
  const row =
    lead === null
      ? null
      : {
          timeline: null,
          location: 'Noida',
          minBudget: null,
          maxBudget: null,
          bedrooms: null,
          financingStatus: null,
          motivation: null,
          qualificationAnswers: {},
          memorySummary: 'Prefers texts after 6pm.',
          memoryUpdatedAt: new Date('2026-10-28T10:00:00Z'),
          ...lead,
        };
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => ({ qualificationQuestions: saved })),
      upsert: vi.fn(async () => ({})),
    },
    lead: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }: any) => Object.assign(row ?? {}, data)),
    },
  };
  return { service: new QualificationQuestionsService(prisma as any), prisma, row };
}

const byKey = (m: { questions: { question: { key: string }; value: string | null; answer?: any }[] }, key: string) =>
  m.questions.find((s) => s.question.key === key)!;

describe('the org question list', () => {
  it('is the built-in defaults when nothing is saved', async () => {
    const qs = await setup({}, null).service.get('org-1');
    expect(qs.map((q) => q.key)).toEqual(['timeline', 'location', 'budget', 'bedrooms', 'financing', 'motivation']);
  });

  it('is saved cleaned, with the built-ins left out kept as disabled', async () => {
    const s = setup();
    const saved = await s.service.set('org-1', [...SAVED, { key: 'Bad key', label: 'x', question: 'x?' }]);
    expect(saved.find((q) => q.key === 'budget')).toMatchObject({ enabled: false });
    expect(saved.some((q) => q.key === 'Bad key')).toBe(false);
    expect(s.prisma.organizationSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1' }, create: expect.objectContaining({ orgId: 'org-1' }) }),
    );
  });
});

describe("a lead's memory", () => {
  it('lists every enabled question with its answer, and the note', async () => {
    const s = setup({ qualificationAnswers: { family: { value: 5, at: '2026-10-28T09:00:00Z', source: 'call', refId: 'call-1' } } });
    const m = await s.service.forLead('org-1', 'lead-1');

    expect(m.questions.map((x) => x.question.key)).toEqual(['property_type', 'family', 'location']);
    expect(byKey(m, 'family')).toMatchObject({ value: '5', answer: { source: 'call' } });
    expect(byKey(m, 'location').value).toBe('Noida');
    expect(byKey(m, 'property_type').value).toBeNull();
    expect(m.summary).toBe('Prefers texts after 6pm.');
    expect(m.summaryAt).toBe('2026-10-28T10:00:00.000Z');
  });

  it('has no note for a lead never talked to', async () => {
    const m = await setup({ memorySummary: null, memoryUpdatedAt: null }).service.forLead('org-1', 'lead-1');
    expect(m).toMatchObject({ summary: null, summaryAt: null });
  });

  it('is not found for a lead of another org', async () => {
    await expect(setup(null).service.forLead('org-1', 'lead-x')).rejects.toThrow('No such lead');
  });
});

describe("a person's edit", () => {
  it('stores the answer as entered by hand, checked against the question', async () => {
    const s = setup();
    const m = await s.service.setAnswer('org-1', 'lead-1', 'property_type', 'flat');
    expect(byKey(m, 'property_type')).toMatchObject({ value: 'Flat', answer: { value: 'Flat', source: 'manual' } });
  });

  it('turns a typed number into a number', async () => {
    const s = setup();
    await s.service.setAnswer('org-1', 'lead-1', 'family', '1,200');
    expect(s.prisma.lead.update.mock.calls[0][0].data.qualificationAnswers.family.value).toBe(1200);
  });

  it('clears the answer on null or an empty string, so the AI asks again', async () => {
    for (const empty of [null, '']) {
      const s = setup({ qualificationAnswers: { family: { value: 5, at: 'x', source: 'call' } } });
      const m = await s.service.setAnswer('org-1', 'lead-1', 'family', empty);
      expect(byKey(m, 'family').value).toBeNull();
    }
  });

  it('refuses an answer that does not fit the question', async () => {
    await expect(setup().service.setAnswer('org-1', 'lead-1', 'property_type', 'Villa')).rejects.toThrow('Not a valid answer');
    await expect(setup().service.setAnswer('org-1', 'lead-1', 'family', 'five')).rejects.toThrow('Not a valid answer');
    await expect(setup().service.setAnswer('org-1', 'lead-1', 'family', { n: 5 })).rejects.toThrow('text, a number or yes/no');
  });

  it('cannot edit a built-in question or an unknown one', async () => {
    await expect(setup().service.setAnswer('org-1', 'lead-1', 'location', 'Delhi')).rejects.toThrow('No such custom question');
    await expect(setup().service.setAnswer('org-1', 'lead-1', 'nope', 'x')).rejects.toThrow('No such custom question');
  });

  it('cannot edit a lead of another org', async () => {
    await expect(setup(null).service.setAnswer('org-1', 'lead-x', 'family', 3)).rejects.toThrow('No such lead');
  });
});

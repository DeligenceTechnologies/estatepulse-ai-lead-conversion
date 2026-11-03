import { describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';
import { NOTHING_KNOWN, NOTHING_TO_ASK, normalizeQuestions } from './qualification';

const questions = normalizeQuestions([
  { key: 'property_type', label: 'Property type', question: 'Plot or flat?', type: 'choice', options: ['Plot', 'Flat'], enabled: true },
  { key: 'location', label: 'Location', question: 'Which area?', enabled: true },
]);

function make(lead: Record<string, unknown> | null) {
  const prisma = {
    lead: { findFirst: vi.fn(async () => lead) },
    organization: { findUnique: vi.fn(async () => ({ name: 'Sunny Homes' })) },
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Kolkata' })) },
    message: { findMany: vi.fn(async () => []) },
  };
  const service = new ActivityService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { get: vi.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    { get: vi.fn(async () => questions) } as any,
  );
  return service;
}

const LEAD = {
  firstName: 'Ana',
  lastName: null,
  email: null,
  phone: '+15125550147',
  location: null,
  minBudget: null,
  maxBudget: null,
  bedrooms: null,
  timeline: null,
  financingStatus: null,
  temperature: 'warm',
  motivation: null,
  callbackAt: null,
  qualificationAnswers: {},
  memorySummary: null,
};

/** Every call and text chat reads the lead's memory from here, so nothing is asked twice. */
describe("the lead's memory in the assistant's variables", () => {
  it('asks everything, and says so, for a new lead', async () => {
    const v = await make(LEAD).leadVariables('org-1', 'lead-1');
    expect(v).toMatchObject({
      knownInfo: NOTHING_KNOWN,
      questionsToAsk: '1. Plot or flat? (Plot / Flat)\n2. Which area?',
      nextQuestion: 'Plot or flat?',
      conversationSummary: 'None yet.',
    });
  });

  it('moves what the lead told us on a call or in a text out of the questions', async () => {
    const v = await make({
      ...LEAD,
      location: 'Noida',
      qualificationAnswers: { property_type: { value: 'Flat', at: '2026-10-28T10:00:00Z', source: 'sms' } },
      memorySummary: 'Prefers texts after 6pm.',
    }).leadVariables('org-1', 'lead-1');

    expect(v.knownInfo).toBe('- Property type: Flat\n- Location: Noida');
    expect(v.questionsToAsk).toBe(NOTHING_TO_ASK);
    expect(v.nextQuestion).toBe('');
    expect(v.conversationSummary).toBe('Prefers texts after 6pm.');
  });

  it('keeps the lead details beside the memory', async () => {
    const v = await make(LEAD).leadVariables('org-1', 'lead-1');
    expect(v).toMatchObject({ firstName: 'Ana', brokerage: 'Sunny Homes', leadId: 'lead-1' });
  });

  it('treats a blank note as none', async () => {
    const v = await make({ ...LEAD, memorySummary: '   ' }).leadVariables('org-1', 'lead-1');
    expect(v.conversationSummary).toBe('None yet.');
  });

  it('gives nothing for an unknown lead', async () => {
    expect(await make(null).leadVariables('org-1', 'lead-x')).toEqual({});
  });
});

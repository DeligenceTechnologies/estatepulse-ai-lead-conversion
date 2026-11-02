import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadInsightsService, MEMORY_SUMMARY_MAX } from './lead-insights.service';
import { normalizeQuestions, type Question } from './qualification';
import { telnyx } from './telnyx-api';

vi.mock('./telnyx-api', () => ({ telnyx: vi.fn() }));

const custom = normalizeQuestions([{ key: 'property_type', label: 'Property type', question: 'Plot or flat?', type: 'choice', options: ['Plot', 'Flat'], enabled: true }]);

const EXTRACTION = {
  timeline: 'unknown',
  budget_identified: false,
  location_identified: false,
  pre_approved: false,
  appointment_requested: false,
  high_engagement: true,
  not_interested: false,
  invalid_lead: false,
  human_requested: false,
  callback_requested: false,
  summary: 'Wants a flat.',
  budget_min: null,
  budget_max: null,
  location: null,
  bedrooms: null,
  financing: null,
  motivation: null,
  answers: { property_type: 'Flat' },
};

function make(questions: Question[] = custom, creds: object | null = { apiKey: 'KEY', assistantId: 'assistant-1' }) {
  const questionsService = { get: vi.fn(async () => questions) };
  const service = new LeadInsightsService({ getCreds: vi.fn(async () => creds) } as any, questionsService as any);
  return { service, questionsService };
}

const completion = (content: unknown) => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
const sent = (i = 0) => JSON.parse(String((vi.mocked(telnyx).mock.calls[i][2] as any).body));

beforeEach(() => {
  vi.mocked(telnyx).mockReset();
});

describe('reading a text chat', () => {
  it("asks for the org's own questions and says it is a text chat", async () => {
    vi.mocked(telnyx).mockResolvedValue(completion(EXTRACTION) as any);
    const x = await make().service.extractFromChat('org-1', 'Us: Plot or flat?\nLead: Flat');

    expect(x.answers).toEqual({ property_type: 'Flat' });
    const body = sent();
    expect(body.messages[0].content).toContain('text-message chat');
    expect(body.messages[1].content).toBe('Us: Plot or flat?\nLead: Flat');
    expect(Object.keys(body.response_format.json_schema.schema.properties.answers.properties)).toEqual(['property_type']);
  });

  it('a call transcript gets the call note instead', async () => {
    vi.mocked(telnyx).mockResolvedValue(completion(EXTRACTION) as any);
    await make().service.extractFromTranscript('org-1', 'Channel 1: hi');
    expect(sent().messages[0].content).toContain('recording channel');
    expect(sent().messages[0].content).not.toContain('text-message chat');
  });

  it('refuses an answer it cannot read', async () => {
    vi.mocked(telnyx).mockResolvedValue(completion('not json') as any);
    await expect(make().service.extractFromChat('org-1', 'Lead: hi')).rejects.toThrow('usable qualification');
  });

  it('needs the Telnyx account', async () => {
    await expect(make(custom, null).service.extractFromChat('org-1', 'Lead: hi')).rejects.toThrow('Connect your Telnyx account');
    expect(telnyx).not.toHaveBeenCalled();
  });
});

describe('rewriting the memory note', () => {
  it('sends the current note and the newest conversation, and returns the new note', async () => {
    vi.mocked(telnyx).mockResolvedValue(completion({ note: '  Prefers texts after 6pm.  ' }) as any);
    const note = await make().service.rewriteMemory('org-1', 'Wants a flat.', 'Lead: text me after 6pm');

    expect(note).toBe('Prefers texts after 6pm.');
    expect(sent().messages[1].content).toBe('Current note:\nWants a flat.\n\nNewest conversation:\nLead: text me after 6pm');
  });

  it('says the note is empty for a lead with none yet', async () => {
    vi.mocked(telnyx).mockResolvedValue(completion({ note: 'x' }) as any);
    await make().service.rewriteMemory('org-1', null, 'Lead: hi');
    expect(sent().messages[1].content).toContain('Current note:\n(empty)');
  });

  it(`caps the note at ${MEMORY_SUMMARY_MAX} characters`, async () => {
    vi.mocked(telnyx).mockResolvedValue(completion({ note: 'x'.repeat(5000) }) as any);
    expect(await make().service.rewriteMemory('org-1', null, 'Lead: hi')).toHaveLength(MEMORY_SUMMARY_MAX);
  });

  it('sends only the end of a very long conversation', async () => {
    vi.mocked(telnyx).mockResolvedValue(completion({ note: 'x' }) as any);
    await make().service.rewriteMemory('org-1', null, `START${'y'.repeat(20_000)}END`);
    const content = sent().messages[1].content as string;
    expect(content).toContain('END');
    expect(content).not.toContain('START');
  });

  it('refuses an unusable answer instead of wiping the note', async () => {
    vi.mocked(telnyx).mockResolvedValue(completion('garbage') as any);
    await expect(make().service.rewriteMemory('org-1', 'keep me', 'Lead: hi')).rejects.toThrow('usable memory note');
    vi.mocked(telnyx).mockResolvedValue(completion({ other: 1 }) as any);
    await expect(make().service.rewriteMemory('org-1', 'keep me', 'Lead: hi')).rejects.toThrow('usable memory note');
  });
});

describe('the call Insight follows the question list', () => {
  const routes = () =>
    vi.mocked(telnyx).mockImplementation((async (_key: string, path: string, init?: { method?: string }) => {
      if (path.startsWith('/ai/conversations/insights?')) return { data: [] };
      if (path === '/ai/conversations/insights' && init?.method === 'POST') return { data: { id: 'insight-1' } };
      if (path.startsWith('/ai/assistants/')) return { data: { insight_settings: { insight_group_id: 'group-1' } } };
      if (path.startsWith('/ai/conversations/insight-groups/group-1')) return { data: { insights: [{ id: 'insight-1' }] } };
      return { data: {} };
    }) as any);
  const insightWrites = () => vi.mocked(telnyx).mock.calls.filter(([, path, init]) => path === '/ai/conversations/insights' && (init as any)?.method === 'POST');

  it('is set up once for the same questions, and again when they change', async () => {
    routes();
    const m = make();
    await m.service.ensureProvisioned('org-1');
    await m.service.ensureProvisioned('org-1');
    expect(insightWrites()).toHaveLength(1);
    expect(JSON.parse(String((insightWrites()[0][2] as any).body)).json_schema.properties.answers).toBeDefined();

    m.questionsService.get.mockResolvedValue(
      normalizeQuestions([{ key: 'loan', label: 'Loan', question: 'Need a loan?', type: 'boolean', enabled: true }]),
    );
    await m.service.ensureProvisioned('org-1');
    expect(insightWrites()).toHaveLength(2);
  });

  it('does nothing without an assistant', async () => {
    await make(custom, { apiKey: 'KEY' }).service.ensureProvisioned('org-1');
    expect(telnyx).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './assistant.service';
import { NOTHING_KNOWN, QUALIFICATION_PROMPT_START, normalizeQuestions, withQualificationSection } from './qualification';

const questions = normalizeQuestions([{ key: 'family', label: 'Family', question: 'How many family members?', type: 'number', enabled: true }]);
const DEFAULTS = { knownInfo: NOTHING_KNOWN, questionsToAsk: '1. How many family members?', nextQuestion: 'How many family members?', conversationSummary: 'None yet.' };

type Sent = { url: string; method: string; body?: any };

function setup(assistant: Record<string, unknown>) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      sent.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const data = method === 'POST' ? { id: 'assistant-new', ...JSON.parse(init!.body!) } : assistant;
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' };
    }),
  );
  const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })), saveCreds: vi.fn(async () => undefined) };
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => ({ callRecordingEnabled: false, callRecordingAnnounce: false, inCallBooking: null, callTools: null })),
      updateMany: vi.fn(async () => ({})),
    },
  };
  const service = new AssistantService(creds as any, prisma as any, { isEnabled: vi.fn(async () => false) } as any, { get: vi.fn(async () => questions) } as any);
  const patches = () => sent.filter((s) => s.method === 'PATCH');
  return { service, sent, patches };
}

afterEach(() => vi.unstubAllGlobals());

describe('the qualification section on the assistant', () => {
  it('is added to a prompt without it, with the default memory variables', async () => {
    const s = setup({ instructions: '# Role\nBe nice.', dynamic_variables: { office_hours: '10-7' } });
    await s.service.syncQualification('org-1');

    expect(s.patches()).toHaveLength(1);
    const body = s.patches()[0].body;
    expect(body.instructions).toBe(withQualificationSection('# Role\nBe nice.'));
    expect(body.dynamic_variables).toEqual({ office_hours: '10-7', ...DEFAULTS });
  });

  it('is left alone when the prompt and the defaults are already current', async () => {
    const s = setup({ instructions: withQualificationSection('# Role'), dynamic_variables: { ...DEFAULTS } });
    await s.service.syncQualification('org-1');
    expect(s.patches()).toHaveLength(0);
  });

  it('updates only the defaults when the questions changed', async () => {
    const s = setup({ instructions: withQualificationSection('# Role'), dynamic_variables: { ...DEFAULTS, questionsToAsk: '1. Old question?' } });
    await s.service.syncQualification('org-1');
    expect(s.patches()[0].body).toEqual({ dynamic_variables: DEFAULTS });
  });

  it('survives a prompt saved from AI Settings, and an edit there cannot remove the memory variables', async () => {
    const s = setup({ instructions: '' });
    await s.service.updateAssistant('org-1', { instructions: 'My own prompt', dynamic_variables: { office_hours: '10-7', knownInfo: 'typed by hand' } });

    const body = s.patches()[0].body;
    expect(body.instructions.split(QUALIFICATION_PROMPT_START)).toHaveLength(2);
    expect(body.instructions.startsWith('My own prompt')).toBe(true);
    expect(body.dynamic_variables).toEqual({ office_hours: '10-7', ...DEFAULTS });
  });

  it('is part of a newly created assistant', async () => {
    const s = setup({});
    await s.service.createAssistant('org-1', { model: 'model-1' });
    const created = s.sent.find((x) => x.method === 'POST')!.body;
    expect(created.instructions).toContain(QUALIFICATION_PROMPT_START);
    expect(created.dynamic_variables).toEqual(DEFAULTS);
  });
});

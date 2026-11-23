import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './assistant.service';
import { KNOWLEDGE_PROMPT_START } from './knowledge';
import { normalizeQuestions } from './qualification';

/**
 * The assistant's knowledge base tool (Telnyx `retrieval`): reading which
 * bucket it searches, and pointing it at one without disturbing any other tool
 * or the owner's prompt.
 */

const HANGUP = { tool_id: 'tool-1', type: 'hangup', shared: false, timeout_ms: 5000, hangup: { description: 'End the call.' } };
const WEBHOOK = { tool_id: 'tool-2', type: 'webhook', shared: true, webhook: { name: 'schedule_callback', url: 'https://x/y' } };
const retrieval = (bucket: string, max: number, shared = false) => ({
  tool_id: 'tool-3',
  type: 'retrieval',
  shared,
  timeout_ms: 5000,
  retrieval: { bucket_ids: [bucket], max_num_results: max, description: '' },
});

type Sent = { url: string; method: string; body?: any };

function setup(assistant: Record<string, unknown>) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      sent.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, json: async () => ({ data: assistant }), text: async () => '' };
    }),
  );
  const service = new AssistantService(
    { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })) } as any,
    { organizationSetting: { findUnique: vi.fn(async () => ({ knowledge: null, callTools: null, inCallBooking: null })) } } as any,
    { isEnabled: vi.fn(async () => false) } as any,
    { get: vi.fn(async () => normalizeQuestions([])) } as any,
  );
  const toolWrites = () => sent.filter((s) => s.method === 'PATCH' && s.body?.tools);
  const promptWrites = () => sent.filter((s) => s.method === 'PATCH' && typeof s.body?.instructions === 'string');
  return { service, sent, toolWrites, promptWrites };
}

afterEach(() => vi.unstubAllGlobals());

describe('reading the assistant\'s knowledge base', () => {
  it('is none when the assistant has no retrieval tool', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [HANGUP] });
    await expect(s.service.retrieval('org-1')).resolves.toBeNull();
  });

  it('reads the bucket, including one made in the Telnyx portal', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [HANGUP, retrieval('portal-kb', 3)] });
    await expect(s.service.retrieval('org-1')).resolves.toEqual({ bucket: 'portal-kb', shared: false });
  });

  it('marks one attached from the Telnyx tools library', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [retrieval('lib-kb', 5, true)] });
    await expect(s.service.retrieval('org-1')).resolves.toMatchObject({ bucket: 'lib-kb', shared: true });
  });
});

describe('pointing the assistant at a knowledge base', () => {
  it('adds the tool and sends every other inline tool back as it was', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [HANGUP, WEBHOOK] });
    await s.service.setRetrieval('org-1', 'ep-kb-1');

    expect(s.toolWrites()).toHaveLength(1);
    expect(s.toolWrites()[0].body.tools).toEqual([
      { type: 'hangup', timeout_ms: 5000, hangup: { description: 'End the call.' } },
      { type: 'retrieval', retrieval: { bucket_ids: ['ep-kb-1'], max_num_results: 3 } },
    ]);
    // The shared tool is never copied inline; it is re-attached by its id.
    expect(s.sent.some((c) => c.method === 'PUT' && c.url.endsWith('/tools/tool-2'))).toBe(true);
  });

  it('replaces the tool it already has, so there is never a second one, and keeps its result count', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [HANGUP, retrieval('ep-kb-1', 7)] });
    await s.service.setRetrieval('org-1', 'ep-kb-2');
    const tools = s.toolWrites()[0].body.tools as any[];
    expect(tools.filter((t) => t.type === 'retrieval')).toEqual([{ type: 'retrieval', retrieval: { bucket_ids: ['ep-kb-2'], max_num_results: 7 } }]);
    expect(tools).toHaveLength(2);
  });

  it('refuses to touch a knowledge base that is a shared Telnyx tool', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [HANGUP, retrieval('lib-kb', 3, true)] });
    await expect(s.service.setRetrieval('org-1', 'ep-kb-1')).rejects.toThrow(/Telnyx portal/);
    expect(s.sent.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('never sends the prompt along with the tools', async () => {
    const s = setup({ instructions: 'Be nice.', tools: [HANGUP] });
    await s.service.setRetrieval('org-1', 'ep-kb-1');
    expect(Object.keys(s.toolWrites()[0].body)).toEqual(['tools']);
  });
});

describe('the prompt of an assistant with documents', () => {
  it('tells it to search them, keeping the owner\'s own text', async () => {
    const s = setup({ instructions: '# Role\nBe nice.', tools: [HANGUP, retrieval('ep-kb-1', 3)] });
    await s.service.syncKnowledge('org-1');
    const { instructions } = s.promptWrites()[0].body;
    expect(instructions.startsWith('# Role\nBe nice.')).toBe(true);
    expect(instructions).toContain(KNOWLEDGE_PROMPT_START);
    expect(instructions).toMatch(/search the brokerage's documents/);
    expect(instructions).not.toMatch(/You have not been given any facts/);
    expect(instructions).toMatch(/Never guess/);
  });

  it('tells one without documents that it has no facts, as before', async () => {
    const s = setup({ instructions: '# Role\nBe nice.', tools: [HANGUP] });
    await s.service.syncKnowledge('org-1');
    const { instructions } = s.promptWrites()[0].body;
    expect(instructions).toMatch(/You have not been given any facts/);
    expect(instructions).not.toMatch(/search the brokerage's documents/);
  });
});

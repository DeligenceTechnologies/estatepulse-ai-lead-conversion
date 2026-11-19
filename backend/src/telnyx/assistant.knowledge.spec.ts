import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './assistant.service';
import { KNOWLEDGE_PROMPT_START, knowledgeSection } from './knowledge';
import { QUALIFICATION_PROMPT_START, normalizeQuestions } from './qualification';
import { SMS_PROMPT_START } from './sms/sms-prompt';

const FACTS = [
  { title: 'Areas served', body: 'Plano, Frisco, McKinney and Allen.' },
  { title: 'Commission', body: '3% on the listing side.' },
];

const questions = normalizeQuestions([{ key: 'family', label: 'Family', question: 'How many family members?', type: 'number', enabled: true }]);

type Sent = { url: string; method: string; body?: any };

function setup(
  assistant: Record<string, unknown>,
  options: { knowledge?: unknown; settingsFail?: boolean; texting?: boolean } = {},
) {
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
      findUnique: vi.fn(async () => {
        if (options.settingsFail) throw new Error('database unreachable');
        return {
          callRecordingEnabled: false,
          callRecordingAnnounce: false,
          inCallBooking: null,
          callTools: null,
          knowledge: options.knowledge ?? null,
        };
      }),
      updateMany: vi.fn(async () => ({})),
    },
  };
  const service = new AssistantService(
    creds as any,
    prisma as any,
    { isEnabled: vi.fn(async () => options.texting ?? false) } as any,
    { get: vi.fn(async () => questions) } as any,
  );
  const patches = () => sent.filter((s) => s.method === 'PATCH');
  return { service, sent, patches, prisma };
}

afterEach(() => vi.unstubAllGlobals());

describe('syncing the knowledge section to the assistant', () => {
  it('writes the facts into a prompt that does not have them', async () => {
    const s = setup({ instructions: '# Role\nBe nice.' }, { knowledge: FACTS });
    await s.service.syncKnowledge('org-1');

    expect(s.patches()).toHaveLength(1);
    const { instructions } = s.patches()[0].body;
    expect(instructions).toContain('- Areas served: Plano, Frisco, McKinney and Allen.');
    expect(instructions).toContain('- Commission: 3% on the listing side.');
    expect(instructions.startsWith('# Role\nBe nice.')).toBe(true);
  });

  it('leaves the base instructions and the other managed sections alone', async () => {
    const existing = `# Role\nBe nice.\n\n${QUALIFICATION_PROMPT_START}\nAsk the budget.\n[End of EstatePulse qualification questions]`;
    const s = setup({ instructions: existing }, { knowledge: FACTS });
    await s.service.syncKnowledge('org-1');

    const { instructions } = s.patches()[0].body;
    expect(instructions).toContain('# Role\nBe nice.');
    expect(instructions).toContain(QUALIFICATION_PROMPT_START);
    expect(instructions).toContain('Ask the budget.');
  });

  it('writes nothing when the prompt is already what it should be', async () => {
    const already = `# Role\nBe nice.\n\n${knowledgeSection(FACTS)}`;
    const s = setup({ instructions: already }, { knowledge: FACTS });
    await s.service.syncKnowledge('org-1');

    expect(s.patches()).toHaveLength(0);
  });

  it('drops the facts but keeps the never-guess rule when the org clears them', async () => {
    const already = `# Role\nBe nice.\n\n${knowledgeSection(FACTS)}`;
    const s = setup({ instructions: already }, { knowledge: [] });
    await s.service.syncKnowledge('org-1');

    expect(s.patches()).toHaveLength(1);
    const { instructions } = s.patches()[0].body;
    expect(instructions).not.toContain('- Commission: 3% on the listing side.');
    expect(instructions).toContain(KNOWLEDGE_PROMPT_START);
    expect(instructions).toMatch(/have an agent confirm/);
    expect(instructions).toContain('# Role\nBe nice.');
    expect(instructions).toBe(`# Role\nBe nice.\n\n${knowledgeSection([])}`);
  });

  it('writes the never-guess rule onto an assistant that has no knowledge section yet', async () => {
    const s = setup({ instructions: '# Role\nBe nice.' }, { knowledge: null });
    await s.service.syncKnowledge('org-1');

    expect(s.patches()).toHaveLength(1);
    expect(s.patches()[0].body.instructions).toMatch(/have an agent confirm/);
  });

  it('does nothing at all when no assistant is connected', async () => {
    const s = setup({ instructions: '# Role' }, { knowledge: FACTS });
    (s.service as any).creds.getCreds = vi.fn(async () => ({ apiKey: 'KEY', assistantId: '' }));
    await s.service.syncKnowledge('org-1');
    expect(s.patches()).toHaveLength(0);
  });
});

describe('refusing to damage a prompt', () => {
  it('will not write when the prompt cannot be read back', async () => {
    const s = setup({ instructions: undefined }, { knowledge: FACTS });
    await expect(s.service.syncKnowledge('org-1')).rejects.toThrow(/could not read the assistant prompt/i);
    expect(s.patches()).toHaveLength(0);
  });

  it('will not write when the saved knowledge cannot be read', async () => {
    const s = setup({ instructions: '# Role\nBe nice.' }, { settingsFail: true });
    await expect(s.service.syncKnowledge('org-1')).rejects.toThrow(/could not read the saved knowledge/i);
    expect(s.patches()).toHaveLength(0);
  });

  it('keeps the saved section when a form save cannot read the settings row', async () => {
    const existing = `# Role\nBe nice.\n\n${knowledgeSection(FACTS)}`;
    const s = setup({ instructions: existing }, { settingsFail: true });
    // A settings row we cannot read must not be taken to mean "no knowledge":
    // that would delete the section the owner saved. The save still goes
    // through — only the knowledge part of it is left exactly as it was.
    await s.service.updateAssistant('org-1', { instructions: existing });

    const written = s.patches().map((p) => p.body?.instructions).filter((x): x is string => typeof x === 'string');
    expect(written).not.toHaveLength(0);
    for (const instructions of written) {
      expect(instructions).toContain(KNOWLEDGE_PROMPT_START);
      expect(instructions).toContain('- Commission: 3% on the listing side.');
    }
  });
});

describe('an owner saving the base prompt from AI Settings', () => {
  it('keeps the knowledge section rather than dropping it', async () => {
    const s = setup({ instructions: '# Role\nold text.' }, { knowledge: FACTS });
    await s.service.updateAssistant('org-1', { instructions: '# Role\nnew text.' });

    const { instructions } = s.patches()[0].body;
    expect(instructions).toContain('# Role\nnew text.');
    expect(instructions).toContain(KNOWLEDGE_PROMPT_START);
    expect(instructions).toContain('- Commission: 3% on the listing side.');
    expect(instructions).toContain(QUALIFICATION_PROMPT_START);
  });

  it('carries the same facts for texts as for calls, in one set of instructions', async () => {
    const s = setup({ instructions: '# Role\nBe nice.' }, { knowledge: FACTS, texting: true });
    await s.service.updateAssistant('org-1', { instructions: '# Role\nBe nice.' });

    const bodies = s.patches().map((p) => p.body).filter((b) => typeof b?.instructions === 'string');
    expect(bodies).toHaveLength(1);
    // Telnyx answers texts with the assistant's own instructions, so the text
    // section and the facts live in the same string. One write serves both.
    expect(bodies[0].instructions).toContain(SMS_PROMPT_START);
    expect(bodies[0].instructions).toContain(KNOWLEDGE_PROMPT_START);
  });
});

/**
 * Both memos (call setup and knowledge) are per assistant, so these drive the
 * same service twice to see whether the second run actually happens.
 */
function setupRetryHarness(knowledgePatchFails: () => boolean, options: { assistantId?: string } = {}) {
  const calls: { method: string; body?: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, body });
      const isKnowledgeWrite = method === 'PATCH' && typeof body?.instructions === 'string' && body.instructions.includes(KNOWLEDGE_PROMPT_START);
      if (isKnowledgeWrite && knowledgePatchFails()) return { ok: false, status: 502, json: async () => ({}), text: async () => 'upstream down' };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { instructions: '# Role\nBe nice.', tools: [{ type: 'hangup' }], telephony_settings: {} } }),
        text: async () => '',
      };
    }),
  );
  const assistantId = options.assistantId ?? 'assistant-1';
  const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId })) };
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => ({ callRecordingEnabled: false, inCallBooking: null, callTools: null, knowledge: FACTS })),
      updateMany: vi.fn(async () => ({})),
    },
  };
  const service = new AssistantService(creds as any, prisma as any, { isEnabled: vi.fn(async () => false) } as any, { get: vi.fn(async () => questions) } as any);
  return { service, calls };
}

describe('recovering from a failed sync', () => {
  const setupRetry = setupRetryHarness;

  it('does the setup work only once while everything succeeds', async () => {
    const s = setupRetry(() => false);
    await s.service.ensureCallSetup('org-1');
    const afterFirst = s.calls.length;
    await s.service.ensureCallSetup('org-1');
    expect(s.calls.length).toBe(afterFirst);
  });

  it('tries again on the next call when the knowledge write failed', async () => {
    let failing = true;
    const s = setupRetry(() => failing);
    await s.service.ensureCallSetup('org-1');
    const afterFirst = s.calls.length;

    // Telnyx recovers; the next call must run setup again rather than trusting
    // the memo, or the prompt would stay stale until the process restarts.
    failing = false;
    await s.service.ensureCallSetup('org-1');
    expect(s.calls.length).toBeGreaterThan(afterFirst);
    const knowledgeWrites = s.calls.filter((c) => c.method === 'PATCH' && c.body?.instructions?.includes(KNOWLEDGE_PROMPT_START));
    expect(knowledgeWrites.length).toBeGreaterThanOrEqual(2);

    // And once it has succeeded, it settles down again.
    const afterSecond = s.calls.length;
    await s.service.ensureCallSetup('org-1');
    expect(s.calls.length).toBe(afterSecond);
  });
});

describe('recovery for an org that never places an outbound call', () => {
  it('syncs knowledge the first time, then costs nothing on later texts', async () => {
    const s = setupRetryHarness(() => false);
    await s.service.ensureKnowledge('org-1');
    const afterFirst = s.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await s.service.ensureKnowledge('org-1');
    await s.service.ensureKnowledge('org-1');
    // Memoized per assistant: a busy chat must not re-read the prompt per message.
    expect(s.calls.length).toBe(afterFirst);
  });

  it('retries on the next text after a failed sync, then settles', async () => {
    let failing = true;
    const s = setupRetryHarness(() => failing);
    await s.service.ensureKnowledge('org-1');
    const afterFailure = s.calls.length;

    failing = false;
    await s.service.ensureKnowledge('org-1');
    expect(s.calls.length).toBeGreaterThan(afterFailure);

    const afterRecovery = s.calls.length;
    await s.service.ensureKnowledge('org-1');
    expect(s.calls.length).toBe(afterRecovery);
  });

  it('never rejects, so an inbound text is never failed by it', async () => {
    const s = setupRetryHarness(() => true);
    await expect(s.service.ensureKnowledge('org-1')).resolves.toBeUndefined();
  });

  it('collapses concurrent texts into one sync', async () => {
    const s = setupRetryHarness(() => false);
    await Promise.all([s.service.ensureKnowledge('org-1'), s.service.ensureKnowledge('org-1'), s.service.ensureKnowledge('org-1')]);
    const writes = s.calls.filter((c) => c.method === 'PATCH');
    expect(writes).toHaveLength(1);
  });

  it('does nothing when no assistant is connected', async () => {
    const s = setupRetryHarness(() => false, { assistantId: '' });
    await s.service.ensureKnowledge('org-1');
    expect(s.calls).toHaveLength(0);
  });
});

describe('creating an assistant', () => {
  it('starts it with the facts the org already saved', async () => {
    const s = setup({}, { knowledge: FACTS });
    await s.service.createAssistant('org-1', { model: 'some-model' });

    const created = s.sent.find((x) => x.method === 'POST');
    expect(created?.body.instructions).toContain('- Areas served: Plano, Frisco, McKinney and Allen.');
    expect(created?.body.instructions).toContain(QUALIFICATION_PROMPT_START);
  });
});

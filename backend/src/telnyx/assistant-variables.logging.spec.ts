import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelnyxWebhookController } from './telnyx-webhook.controller';

// The signature itself is covered by telnyx-webhook.signature.spec.ts; here a
// valid one is assumed so the timing path is reachable.
vi.mock('@/common/utils/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyTelnyxSignature: () => true,
}));

/**
 * The variables webhook is the one EstatePulse request Telnyx waits on before
 * the assistant speaks or texts. These cover the timing instrumentation added
 * for B4: that it records how long the work took, that it never changes what is
 * returned, and that it never writes the lead's details into a log line.
 */

const LEAD_PHONE = '+12899174129';
const OUR_NUMBER = '+14155550123';
const CONVERSATION_ID = 'conv-abc-123';

const VARIABLES = {
  firstName: 'Priya',
  phone: LEAD_PHONE,
  email: 'priya@example.com',
  last_outbound_sms: 'Hi Priya, are you still looking in Plano?',
  recent_sms: 'Lead: yes | Us: great',
};

function setup(overrides: { slow?: number; lead?: unknown; failVariables?: boolean } = {}) {
  const lines: { level: string; text: string }[] = [];

  const activity = {
    callByProvider: vi.fn(async () => null),
    leadVariables: vi.fn(async () => {
      if (overrides.slow) await new Promise((r) => setTimeout(r, overrides.slow));
      if (overrides.failVariables) throw new Error('database unreachable');
      return { ...VARIABLES };
    }),
  };
  const creds = {
    orgForNumber: vi.fn(async () => 'org-1'),
    getCreds: vi.fn(async () => ({ apiKey: 'KEY', publicKey: 'PUBLIC_KEY', assistantId: 'assistant-1' })),
  };
  const lead = overrides.lead === undefined ? { id: 'lead-1', takenOverById: null, dncStatus: false } : overrides.lead;
  const prisma = { lead: { findFirst: vi.fn(async () => lead) } };

  const controller = new TelnyxWebhookController(
    activity as any,
    {} as any,
    {} as any,
    creds as any,
    prisma as any,
    {} as any,
    {} as any,
  );
  // Replacing the instance's logger is deterministic; spying on Nest's Logger
  // prototype is not, and this spec is about what the lines say.
  (controller as any).logger = {
    log: (text: unknown) => lines.push({ level: 'log', text: String(text) }),
    warn: (text: unknown) => lines.push({ level: 'warn', text: String(text) }),
    error: (text: unknown) => lines.push({ level: 'error', text: String(text) }),
  };

  const call = (payload: Record<string, unknown> = {}) =>
    controller.assistantVariables(
      {
        data: {
          payload: {
            telnyx_conversation_channel: 'sms_chat',
            telnyx_agent_target: OUR_NUMBER,
            telnyx_end_user_target: LEAD_PHONE,
            telnyx_conversation_id: CONVERSATION_ID,
            ...payload,
          },
        },
      },
      { header: () => undefined, rawBody: Buffer.from('{}') } as any,
    );

  return { controller, call, lines, activity };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.restoreAllMocks());

describe('the variables webhook with timing added', () => {
  it('still returns the lead variables unchanged', async () => {
    const s = setup();
    const result = await s.call();
    expect(result.dynamic_variables).toMatchObject({ firstName: 'Priya', phone: LEAD_PHONE });
    // sms_chat blanks the chat log and keeps the text being replied to.
    expect(result.dynamic_variables?.recent_sms).toBe('');
    expect(result.dynamic_variables?.last_outbound_sms).toBe(VARIABLES.last_outbound_sms);
  });

  it('still pauses the AI for a chat an agent has taken over', async () => {
    const s = setup({ lead: { id: 'lead-1', takenOverById: 'user-1', dncStatus: false } });
    const result = await s.call();
    expect(result.conversation).toEqual({ metadata: { ai_disabled: true } });
  });

  it('still answers with nothing when no lead matches', async () => {
    const s = setup({ lead: null });
    await expect(s.call()).resolves.toEqual({});
  });

  it('records how long the work took, and the conversation it was for', async () => {
    const s = setup();
    await s.call();
    const line = s.lines.find((l) => l.text.includes('assistant variables'));
    expect(line).toBeDefined();
    expect(line!.text).toContain(CONVERSATION_ID);
    expect(line!.text).toMatch(/in \d+ms/);
    expect(line!.text).toContain('org-1');
    expect(line!.text).toContain('lead-1');
  });

  it('warns when the work gets close to the assistant giving up', async () => {
    const s = setup({ slow: 1600 });
    await s.call();
    const warned = s.lines.find((l) => l.level === 'warn' && l.text.includes('slow'));
    expect(warned).toBeDefined();
    expect(warned!.text).toContain('3000ms');
  });

  it('logs no part of the lead or the conversation', async () => {
    const s = setup();
    await s.call();
    const logged = s.lines.map((l) => l.text).join('\n');
    for (const secret of ['Priya', 'priya@example.com', LEAD_PHONE, VARIABLES.last_outbound_sms, VARIABLES.recent_sms, 'KEY']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('records the failure and its timing without leaking the payload', async () => {
    const s = setup({ failVariables: true });
    await expect(s.call()).resolves.toEqual({});
    const failed = s.lines.find((l) => l.level === 'error');
    expect(failed!.text).toMatch(/failed after \d+ms/);
    expect(failed!.text).toContain(CONVERSATION_ID);
    expect(failed!.text).not.toContain(LEAD_PHONE);
  });
});

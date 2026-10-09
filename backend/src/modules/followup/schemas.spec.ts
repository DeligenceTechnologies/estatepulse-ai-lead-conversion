import { describe, expect, it } from 'vitest';
import { createSequenceSchema, enrollSchema, replaceStepsSchema } from './schemas';

/**
 * These bounds shadow CHECK constraints that exist in the database and NOT in
 * schema.prisma, so nothing else in the codebase records them. A rule dropped
 * from here does not fail a typecheck — it turns into a 500 from Postgres the
 * first time somebody uses the editor.
 */

const sms = (over: Record<string, unknown> = {}) => ({
  actionType: 'sms',
  delayMinutes: 60,
  messageTemplate: 'Hi {{firstName}}',
  ...over,
});

const base = (over: Record<string, unknown> = {}) => ({
  name: 'Test',
  code: 'TEST_SEQ',
  steps: [sms()],
  ...over,
});

describe('createSequenceSchema', () => {
  it('accepts a minimal valid sequence', () => {
    const r = createSequenceSchema.safeParse(base());
    expect(r.success).toBe(true);
  });

  it("rejects actionType 'call' — sequence_steps_action_check allows sms|voice", () => {
    const r = createSequenceSchema.safeParse(base({ steps: [sms({ actionType: 'call' })] }));
    expect(r.success).toBe(false);
  });

  it('rejects an SMS step with no message', () => {
    const r = createSequenceSchema.safeParse(
      base({ steps: [{ actionType: 'sms', delayMinutes: 60 }] }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects a voice step with no prompt', () => {
    const r = createSequenceSchema.safeParse(
      base({ steps: [{ actionType: 'voice', delayMinutes: 60 }] }),
    );
    expect(r.success).toBe(false);
  });

  it('accepts a voice step with a prompt', () => {
    const r = createSequenceSchema.safeParse(
      base({ steps: [{ actionType: 'voice', delayMinutes: 60, voicePrompt: 'Ask about timing' }] }),
    );
    expect(r.success).toBe(true);
  });

  it('rejects a zero delay — it would fire together with the previous step', () => {
    expect(createSequenceSchema.safeParse(base({ steps: [sms({ delayMinutes: 0 })] })).success).toBe(
      false,
    );
  });

  it('rejects a delay longer than a year, which is always a typo', () => {
    expect(
      createSequenceSchema.safeParse(base({ steps: [sms({ delayMinutes: 525_601 })] })).success,
    ).toBe(false);
  });

  it('rejects maxAttempts of 0 — sequence_steps_attempts_check is > 0', () => {
    expect(
      createSequenceSchema.safeParse(base({ steps: [sms({ maxAttempts: 0 })] })).success,
    ).toBe(false);
  });

  it('requires at least one step', () => {
    expect(createSequenceSchema.safeParse(base({ steps: [] })).success).toBe(false);
  });

  it.each(['lower_case', '9LEADING_DIGIT', 'has space', 'Mixed_Case'])(
    'rejects the code %j',
    (code) => {
      expect(createSequenceSchema.safeParse(base({ code })).success).toBe(false);
    },
  );

  it('accepts UPPER_SNAKE_CASE codes', () => {
    expect(createSequenceSchema.safeParse(base({ code: 'OPEN_HOUSE_2' })).success).toBe(true);
  });

  it.each([
    'qualified_hot',
    'qualified_warm',
    'qualified_cold',
    'follow_up_no_answer',
    'follow_up_not_ready',
    'follow_up_callback_requested',
    'follow_up_needs_time',
    'follow_up_other',
  ])('accepts auto-enrol on %s', (t) => {
    expect(createSequenceSchema.safeParse(base({ enrollTriggers: [t] })).success).toBe(true);
  });

  it('accepts several conditions at once', () => {
    const r = createSequenceSchema.safeParse(base({ enrollTriggers: ['follow_up_no_answer', 'follow_up_not_ready'] }));
    expect(r.success && r.data.enrollTriggers).toEqual(['follow_up_no_answer', 'follow_up_not_ready']);
  });

  it('rejects a condition the CHECK constraint would refuse', () => {
    expect(createSequenceSchema.safeParse(base({ enrollTriggers: ['lukewarm'] })).success).toBe(
      false,
    );
  });

  it('de-duplicates rather than tripping the unique index on itself', () => {
    const r = createSequenceSchema.safeParse(base({ enrollTriggers: ['follow_up_no_answer', 'follow_up_no_answer'] }));
    expect(r.success && r.data.enrollTriggers).toEqual(['follow_up_no_answer']);
  });

  it('defaults to no conditions — a new sequence never silently swallows leads', () => {
    const r = createSequenceSchema.safeParse(base());
    expect(r.success && r.data.enrollTriggers).toEqual([]);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(createSequenceSchema.safeParse(base({ organizationId: 'someone-else' })).success).toBe(
      false,
    );
  });

  it('never accepts a client-supplied step order', () => {
    expect(createSequenceSchema.safeParse(base({ steps: [sms({ stepOrder: 5 })] })).success).toBe(
      false,
    );
  });
});

describe('replaceStepsSchema', () => {
  it('caps a sequence at twenty steps', () => {
    const steps = Array.from({ length: 21 }, () => sms());
    expect(replaceStepsSchema.safeParse({ steps }).success).toBe(false);
  });

  it('accepts twenty', () => {
    const steps = Array.from({ length: 20 }, () => sms());
    expect(replaceStepsSchema.safeParse({ steps }).success).toBe(true);
  });
});

describe('enrollSchema', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('accepts hand-picked ids', () => {
    expect(enrollSchema.safeParse({ leadIds: [uuid] }).success).toBe(true);
  });

  it('accepts a filter', () => {
    expect(enrollSchema.safeParse({ filter: { temperature: 'warm' } }).success).toBe(true);
  });

  it('accepts an empty filter — "everyone" is a legitimate, if alarming, request', () => {
    expect(enrollSchema.safeParse({ filter: {} }).success).toBe(true);
  });

  it('rejects both at once, which has no sensible meaning', () => {
    expect(enrollSchema.safeParse({ leadIds: [uuid], filter: {} }).success).toBe(false);
  });

  it('rejects neither', () => {
    expect(enrollSchema.safeParse({ dryRun: true }).success).toBe(false);
  });

  it('caps a single call at 500 ids', () => {
    const leadIds = Array.from({ length: 501 }, () => uuid);
    expect(enrollSchema.safeParse({ leadIds }).success).toBe(false);
  });

  it('defaults dryRun to false, so an explicit call really writes', () => {
    const r = enrollSchema.safeParse({ filter: {} });
    expect(r.success && r.data.dryRun).toBe(false);
  });

  it('rejects an unknown filter condition rather than silently ignoring it', () => {
    expect(enrollSchema.safeParse({ filter: { nonsense: true } }).success).toBe(false);
  });
});

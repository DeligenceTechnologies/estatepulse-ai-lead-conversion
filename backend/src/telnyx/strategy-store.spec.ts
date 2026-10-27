import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/common/errors/app-error';
import { StrategyStoreService, defaultStrategy, toTwoStep, validateTwoStep, type Strategy, type StrategyStep } from './strategy-store.service';

const sms = (id: string, value: number, unit: StrategyStep['after']['unit'] = 'minutes', message = `text ${id}`): StrategyStep => ({ id, after: { value, unit }, channel: 'sms', message });
const call = (id: string, value: number, unit: StrategyStep['after']['unit'] = 'minutes'): StrategyStep => ({ id, after: { value, unit }, channel: 'voice' });
const legacy = (steps: StrategyStep[]): Strategy => ({ name: 'Old', guardrails: {}, steps });

describe('toTwoStep', () => {
  it('shows a two-step strategy as it is', () => {
    const s = defaultStrategy();
    expect(toTwoStep(s)).toEqual({ steps: s.steps, converted: false });
  });

  it('turns the old three-step default into its first SMS and first call, the call waiting the real gap', () => {
    const { steps, converted } = toTwoStep(legacy([sms('s1', 0), call('s2', 1), sms('s3', 5)]));
    expect(converted).toBe(true);
    expect(steps.map((s) => [s.id, s.channel, s.after, s.onlyIf])).toEqual([
      ['s1', 'sms', { value: 0, unit: 'minutes' }, undefined],
      ['s2', 'voice', { value: 1, unit: 'minutes' }, { match: 'all', rules: [] }],
    ]);
  });

  it('keeps the order the steps really ran in, whatever order they were listed in', () => {
    const { steps, converted } = toTwoStep(legacy([sms('late', 10), call('early', 2)]));
    expect(converted).toBe(true);
    expect(steps.map((s) => [s.id, s.after])).toEqual([
      ['early', { value: 0, unit: 'minutes' }],
      ['late', { value: 8, unit: 'minutes' }],
    ]);
  });

  it('states the gap in the largest unit that fits, and never as less than zero', () => {
    expect(toTwoStep(legacy([call('a', 0), sms('b', 2, 'hours')])).steps[1].after).toEqual({ value: 2, unit: 'hours' });
    expect(toTwoStep(legacy([call('a', 30, 'seconds'), sms('b', 2, 'minutes')])).steps[1].after).toEqual({ value: 90, unit: 'seconds' });
    expect(toTwoStep(legacy([call('a', 5), sms('b', 5)])).steps[1].after).toEqual({ value: 0, unit: 'seconds' });
  });

  it('a strategy of one kind gets an empty step of the other kind to fill in', () => {
    const { steps, converted } = toTwoStep(legacy([sms('a', 0), sms('b', 5)]));
    expect(converted).toBe(true);
    expect(steps.map((s) => s.channel)).toEqual(['sms', 'voice']);
  });

  it('an old strategy that already is one SMS then one call at once is shown unchanged', () => {
    expect(toTwoStep(legacy([sms('a', 0), call('b', 3)])).converted).toBe(false);
  });
});

describe('validateTwoStep', () => {
  const ok: StrategyStep[] = [sms('a', 0), { ...call('b', 1), condition: 'no_reply' }];
  const reject = (steps: StrategyStep[], message: RegExp) => {
    expect(() => validateTwoStep(steps)).toThrow(AppError);
    expect(() => validateTwoStep(steps)).toThrow(message);
  };

  it('accepts one SMS and one call with a condition the second step allows', () => {
    expect(() => validateTwoStep(ok)).not.toThrow();
    expect(() => validateTwoStep([call('a', 0), { ...sms('b', 5), condition: 'call_not_answered' }])).not.toThrow();
  });

  it.each([
    ['a third step', [...ok, sms('c', 9)], /exactly two steps/],
    ['one step', [sms('a', 0)], /exactly two steps/],
    ['two of a kind', [sms('a', 0), sms('b', 1)], /exactly two steps/],
    ['step 1 starting more than 12 hours in', [sms('a', 13, 'hours'), call('b', 1)], /at most 12 hours/],
    ['a condition on the first step', [{ ...sms('a', 0), condition: 'no_reply' as const }, call('b', 1)], /no condition/],
    ['a condition the channel does not take', [call('a', 0), { ...sms('b', 1), condition: 'no_reply' as const }], /cannot be used on this step/],
    ['an empty text', [sms('a', 0, 'minutes', '  '), call('b', 1)], /needs a message/],
  ])('rejects %s', (_label, steps, message) => reject(steps as StrategyStep[], message));
});

function store(saved: unknown) {
  const prisma = {
    organizationSetting: { findUnique: vi.fn().mockResolvedValue(saved === undefined ? null : { outreachStrategy: saved }), upsert: vi.fn() },
  };
  return { svc: new StrategyStoreService(prisma as any), prisma };
}

describe('StrategyStoreService.saveStrategy', () => {
  it('saving steps saves the two-step form: waits after the step before, no condition on step 1, "always" by default on step 2', async () => {
    const { svc, prisma } = store(legacy([sms('s1', 0), call('s2', 1), sms('s3', 5)]));
    const saved = await svc.saveStrategy('org-1', { steps: [{ ...call('a', 0), condition: 'always' }, sms('b', 5)] });
    expect(saved.timing).toBe('after_previous');
    expect(saved.steps).toEqual([
      { ...call('a', 0), condition: undefined, onlyIf: undefined },
      { ...sms('b', 5), condition: undefined, onlyIf: { match: 'all', rules: [] } },
    ]);
    expect(prisma.organizationSetting.upsert).toHaveBeenCalledOnce();
  });

  it('saving only the contact hours leaves an old strategy old: its steps and timing are not touched', async () => {
    const old = { ...legacy([sms('s1', 0), call('s2', 1), sms('s3', 5)]), guardrails: { stopOn: ['dnc'], maxVoiceAttempts: 3 } };
    const { svc } = store(old);
    const saved = await svc.saveStrategy('org-1', { guardrails: { ...old.guardrails, respectQuietHours: true } });
    expect(saved.steps).toEqual(old.steps);
    expect(saved.timing).toBeUndefined();
    expect(saved.guardrails).toEqual({ stopOn: ['dnc'], maxVoiceAttempts: 3, respectQuietHours: true });
  });

  it('refuses steps that break the two-step rules and saves nothing', async () => {
    const { svc, prisma } = store(undefined);
    await expect(svc.saveStrategy('org-1', { steps: [sms('a', 0), sms('b', 1), call('c', 2)] })).rejects.toThrow(/exactly two steps/);
    expect(prisma.organizationSetting.upsert).not.toHaveBeenCalled();
  });

  it('an office that never saved one runs the two-step default: call at once, text 5 minutes later only if the call was missed', async () => {
    const s = await store(undefined).svc.getStrategy('org-1');
    expect(s.timing).toBe('after_previous');
    expect(() => validateTwoStep(s.steps)).not.toThrow();
    expect(s.steps.map((x) => [x.channel, x.after, x.onlyIf])).toEqual([
      ['voice', { value: 0, unit: 'minutes' }, undefined],
      ['sms', { value: 5, unit: 'minutes' }, { match: 'all', rules: [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] }],
    ]);
    expect(s.steps[1].message).toBe("Hi {{firstName}}, just tried you with a quick call about your home search. When's a good time to chat?");
    expect(s.guardrails).not.toHaveProperty('stopOn');
  });
});

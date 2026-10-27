import { describe, expect, it } from 'vitest';
import { ALWAYS, evaluate, onlyIfError, onlyIfOf, skipDetail, type Facts, type OnlyIf } from './conditions';

const facts = (over: Partial<Facts> = {}): Facts => ({ callOutcome: 'no_answer', smsReply: 'not_replied', ...over });
const rule = (field: any, op: any, value: any) => ({ field, op, value });

describe('evaluate', () => {
  it('no rules is always', () => {
    expect(evaluate(ALWAYS, facts())).toEqual({ ok: true });
    expect(evaluate({ match: 'any', rules: [] }, facts())).toEqual({ ok: true });
  });

  it('AND needs every rule; OR needs one', () => {
    const two: OnlyIf['rules'] = [rule('call_result', 'in', ['no_answer']), rule('sms_reply', 'is', 'replied')];
    expect(evaluate({ match: 'all', rules: two }, facts()).ok).toBe(false);
    expect(evaluate({ match: 'any', rules: two }, facts()).ok).toBe(true);
    expect(evaluate({ match: 'all', rules: two }, facts({ smsReply: 'replied' })).ok).toBe(true);
    expect(evaluate({ match: 'any', rules: two }, facts({ callOutcome: 'conversation' })).ok).toBe(false);
  });

  it('call result: in and not in; a call that never connected or never happened is never "in"', () => {
    const notAnswered = rule('call_result', 'in', ['no_answer', 'voicemail', 'busy', 'short_pickup']);
    for (const o of ['no_answer', 'voicemail', 'busy', 'short_pickup'] as const) expect(evaluate({ match: 'all', rules: [notAnswered] }, facts({ callOutcome: o })).ok).toBe(true);
    for (const o of ['conversation', 'failed', 'none'] as const) expect(evaluate({ match: 'all', rules: [notAnswered] }, facts({ callOutcome: o })).ok).toBe(false);
    expect(evaluate({ match: 'all', rules: [rule('call_result', 'not_in', ['conversation'])] }, facts({ callOutcome: 'busy' })).ok).toBe(true);
  });

  it('SMS reply', () => {
    expect(evaluate({ match: 'all', rules: [rule('sms_reply', 'is', 'not_replied')] }, facts({ smsReply: 'replied' })).ok).toBe(false);
    expect(evaluate({ match: 'all', rules: [rule('sms_reply', 'is', 'not_replied')] }, facts()).ok).toBe(true);
  });

  it('a no says which rule decided it', () => {
    const r = rule('call_result', 'in', ['no_answer']);
    const result = evaluate({ match: 'all', rules: [r] }, facts({ callOutcome: 'conversation' }));
    expect(result).toEqual({ ok: false, because: r });
    expect(skipDetail(r, facts({ callOutcome: 'conversation' }))).toBe('The call result was a conversation');
  });
});

describe('onlyIfOf: older single conditions, mapped and never rewritten', () => {
  it.each([
    [undefined, { match: 'all', rules: [] }],
    ['always', { match: 'all', rules: [] }],
    ['call_not_answered', { match: 'all', rules: [rule('call_result', 'in', ['no_answer', 'voicemail', 'busy', 'short_pickup'])] }],
    ['no_reply', { match: 'all', rules: [rule('sms_reply', 'is', 'not_replied')] }],
    ['not_reached', { match: 'all', rules: [rule('call_result', 'not_in', ['conversation']), rule('sms_reply', 'is', 'not_replied')] }],
  ])('%s', (condition, expected) => {
    expect(onlyIfOf({ condition: condition as any })).toEqual(expected);
  });

  it('a step that has its own rule set keeps it', () => {
    const own: OnlyIf = { match: 'any', rules: [rule('sms_reply', 'is', 'replied')] };
    expect(onlyIfOf({ onlyIf: own, condition: 'no_reply' })).toBe(own);
  });
});

describe('onlyIfError: only the fields that mean something where the step sits', () => {
  it('after a call: call result only', () => {
    expect(onlyIfError({ match: 'all', rules: [rule('call_result', 'in', ['busy'])] }, 'after_call')).toBeNull();
    expect(onlyIfError({ match: 'all', rules: [rule('sms_reply', 'is', 'replied')] }, 'after_call')).toMatch(/cannot be used/);
    expect(onlyIfError({ match: 'all', rules: [rule('temperature', 'in', ['hot'])] }, 'after_call')).toMatch(/cannot be used/);
  });

  it('after a text: SMS reply only', () => {
    expect(onlyIfError({ match: 'all', rules: [rule('sms_reply', 'is', 'not_replied')] }, 'after_sms')).toBeNull();
    expect(onlyIfError({ match: 'all', rules: [rule('call_result', 'in', ['busy'])] }, 'after_sms')).toMatch(/cannot be used/);
  });

  it('sequences: both, as the older "not reached" needs', () => {
    expect(onlyIfError(onlyIfOf({ condition: 'not_reached' }), 'sequence')).toBeNull();
    expect(onlyIfError({ match: 'all', rules: [rule('day', 'is', 'weekend')] }, 'sequence')).toMatch(/cannot be used/);
  });

  it('refuses a bad match, op, value, and more than 10 rules', () => {
    expect(onlyIfError({ match: 'some', rules: [] }, 'sequence')).toMatch(/all or any/);
    expect(onlyIfError({ match: 'all', rules: [rule('sms_reply', 'in', ['replied'])] }, 'sequence')).toMatch(/does not apply/);
    expect(onlyIfError({ match: 'all', rules: [rule('call_result', 'in', ['failed'])] }, 'sequence')).toMatch(/not one this field knows/);
    expect(onlyIfError({ match: 'all', rules: Array(11).fill(rule('sms_reply', 'is', 'replied')) }, 'sequence')).toMatch(/At most 10/);
  });
});

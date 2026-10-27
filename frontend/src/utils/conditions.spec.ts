import { describe, expect, it } from 'vitest';
import { PRESETS, onlyIfOfStep, onlyIfText, presetOf, ruleText } from './conditions';

describe('ruleText: each field in plain words', () => {
  it.each([
    [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }, 'the call result is no answer, voicemail, busy/declined or a short pick-up'],
    [{ field: 'call_result', op: 'not_in', value: ['conversation'] }, 'the call result is not a conversation'],
    [{ field: 'sms_reply', op: 'is', value: 'not_replied' }, "the lead hasn't replied"],
    [{ field: 'sms_reply', op: 'is', value: 'replied' }, 'the lead has replied'],
  ])('%j', (rule, text) => {
    expect(ruleText(rule as any)).toBe(text);
  });

  it('no rules reads as nothing (always)', () => {
    expect(onlyIfText({ match: 'all', rules: [] })).toBe('');
  });
});

describe('the plain dropdown: two choices per place', () => {
  it('after a call, after a text, in a sequence', () => {
    expect(PRESETS.after_call.map((p) => p.label)).toEqual(['Always', 'Only if the call was not answered']);
    expect(PRESETS.after_sms.map((p) => p.label)).toEqual(['Always', "Only if the lead hasn't replied"]);
    expect(PRESETS.sequence.map((p) => p.label)).toEqual(['Always', 'Only if the last call was not answered']);
  });

  it('a saved rule set is read back as its choice, whatever the order of its values', () => {
    expect(presetOf(undefined, 'after_call')?.value).toBe('always');
    expect(presetOf(onlyIfOfStep({ condition: 'call_not_answered' }), 'sequence')?.value).toBe('call_not_answered');
    const shuffled = { match: 'all' as const, rules: [{ field: 'call_result' as const, op: 'in' as const, value: ['short_pickup', 'busy', 'voicemail', 'no_answer'] }] };
    expect(presetOf(shuffled, 'after_call')?.value).toBe('call_not_answered');
  });

  it('anything else is no choice: the dropdown lists it as it is ("Custom"), so it is never lost', () => {
    expect(presetOf(onlyIfOfStep({ condition: 'not_reached' }), 'sequence')).toBeNull();
    expect(presetOf(PRESETS.after_sms[1].onlyIf, 'after_call')).toBeNull();
  });
});

describe('onlyIfOfStep: older single conditions shown as rules', () => {
  it.each([
    [undefined, []],
    ['call_not_answered', [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }]],
    ['no_reply', [{ field: 'sms_reply', op: 'is', value: 'not_replied' }]],
    ['not_reached', [{ field: 'call_result', op: 'not_in', value: ['conversation'] }, { field: 'sms_reply', op: 'is', value: 'not_replied' }]],
  ])('%s', (condition, rules) => {
    expect(onlyIfOfStep({ condition: condition as any })).toEqual({ match: 'all', rules });
  });
});

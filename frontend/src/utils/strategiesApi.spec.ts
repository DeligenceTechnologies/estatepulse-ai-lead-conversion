import { describe, expect, it } from 'vitest';
import { callFirst, stepSummary, stepsError, swapOrder, type StrategyStep } from './strategiesApi';

const call: StrategyStep = { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'voice', action: 'ai_call' };
const notAnswered = { match: 'all' as const, rules: [{ field: 'call_result' as const, op: 'in' as const, value: ['no_answer', 'voicemail'] }] };
const sms: StrategyStep = { id: 'b', after: { value: 5, unit: 'minutes' }, channel: 'sms', message: 'Hi', onlyIf: notAnswered };

describe('swapOrder', () => {
  it('step 2 goes first keeping the start time; the old step 1 waits step 2\'s time after it, its condition starting over', () => {
    const delayed = { ...call, after: { value: 30, unit: 'minutes' as const } };
    expect(swapOrder([delayed, sms])).toEqual([
      { ...sms, after: { value: 30, unit: 'minutes' }, onlyIf: undefined },
      { ...delayed, after: { value: 5, unit: 'minutes' }, onlyIf: { match: 'all', rules: [] } },
    ]);
  });
});

describe('callFirst', () => {
  it('an office without SMS calls first', () => {
    expect(callFirst(swapOrder([call, sms])).map((s) => s.channel)).toEqual(['voice', 'sms']);
    expect(callFirst([call, sms])).toEqual([call, sms]);
  });
});

describe('stepsError', () => {
  it('an empty text, a start past 12 hours or a negative wait is caught before Save', () => {
    expect(stepsError([call, sms])).toBeNull();
    expect(stepsError([{ ...call, after: { value: 12, unit: 'hours' } }, sms])).toBeNull();
    expect(stepsError([{ ...call, after: { value: 13, unit: 'hours' } }, sms])).toBe('Step 1 can start at most 12 hours after the lead comes in.');
    expect(stepsError([call, { ...sms, message: '  ' }])).toBe('The SMS step needs a message.');
    expect(stepsError([call, { ...sms, after: { value: -1, unit: 'minutes' } }])).toBe('Step 2 needs a wait of zero or more.');
  });
});

describe('stepSummary: the plain-English line under each card', () => {
  it('step 1 at once, or after its start delay', () => {
    expect(stepSummary([call, sms], 0)).toBe('This call goes as soon as the lead comes in, within contact hours.');
    expect(stepSummary([{ ...call, after: { value: 2, unit: 'hours' } }, sms], 0)).toBe('This call goes 2 hours after the lead comes in, within contact hours.');
  });

  it('a text after the call counts from when the call ends, and says its condition', () => {
    expect(stepSummary([call, sms], 1)).toBe('This SMS goes 5 min after the call ends, only if the call result is no answer or voicemail.');
  });

  it('a choice from the dropdown reads in its own words', () => {
    const missed = { match: 'all' as const, rules: [{ field: 'call_result' as const, op: 'in' as const, value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] };
    expect(stepSummary([call, { ...sms, onlyIf: missed }], 1)).toBe('This SMS goes 5 min after the call ends, only if the call was not answered.');
  });

  it('a call after the text counts from when it is sent; no conditions reads as always', () => {
    const [first, second] = swapOrder([call, sms]);
    expect(stepSummary([first, second], 1)).toBe('This call goes 5 min after the SMS is sent.');
  });

  it('several conditions join with "and" or "or" as matched', () => {
    const both = { ...sms, onlyIf: { match: 'any' as const, rules: [...notAnswered.rules, { field: 'sms_reply' as const, op: 'is' as const, value: 'replied' }] } };
    expect(stepSummary([call, both], 1)).toBe('This SMS goes 5 min after the call ends, only if the call result is no answer or voicemail, or the lead has replied.');
  });
});

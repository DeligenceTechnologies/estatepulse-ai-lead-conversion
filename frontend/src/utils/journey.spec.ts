import { describe, expect, it } from 'vitest';
import { SEQUENCE_PRESETS, STRATEGY_PRESETS, allowedConditions, fitConditions, fitSteps } from './journey';

describe('step conditions follow the step before', () => {
  it('the first step has none; after a text only "no reply", after a call only "not answered"', () => {
    expect(allowedConditions(undefined)).toEqual({ lastCallMissed: false, noReply: false });
    expect(allowedConditions('sms')).toEqual({ lastCallMissed: false, noReply: true });
    expect(allowedConditions('voice')).toEqual({ lastCallMissed: true, noReply: false });
    expect(fitConditions({ lastCallMissed: true, noReply: true }, 'sms')).toEqual({ noReply: true });
  });

  it('moving a step refits every condition, and leaves a step that still fits untouched', () => {
    type S = { id: string; channel: 'sms' | 'voice'; onlyIf?: { lastCallMissed?: boolean; noReply?: boolean } };
    const text: S = { id: 'a', channel: 'sms' };
    const call: S = { id: 'b', channel: 'voice', onlyIf: { noReply: true } };
    const tried: S = { id: 'c', channel: 'sms', onlyIf: { lastCallMissed: true } };
    const fitted = fitSteps([text, call, tried], (s) => s.channel);
    expect(fitted[1]).toBe(call);
    expect(fitted[2]).toBe(tried);
    // The call moved first: nothing before it, and the text after it can no longer ask about a reply.
    expect(fitSteps([call, text, tried], (s) => s.channel).map((s) => s.onlyIf)).toEqual([undefined, undefined, undefined]);
  });

  it('every template already fits the rule', () => {
    for (const preset of STRATEGY_PRESETS) {
      const steps = preset.steps();
      expect(fitSteps(steps, (s) => s.channel)).toEqual(steps);
    }
    for (const preset of SEQUENCE_PRESETS) {
      const steps = preset.steps();
      expect(fitSteps(steps, (s) => s.actionType)).toEqual(steps);
    }
  });
});

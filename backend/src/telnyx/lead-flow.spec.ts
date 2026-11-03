import { describe, expect, it } from 'vitest';
import { flowFromLog } from './lead-flow';
import type { StrategyStep } from './strategy-store.service';

const sms = (id: string): StrategyStep => ({ id, channel: 'sms', after: { value: 0, unit: 'minutes' }, message: 'hi' });
const voice = (id: string): StrategyStep => ({ id, channel: 'voice', after: { value: 5, unit: 'minutes' } });
const STEPS = [sms('s1'), voice('s2'), sms('s3'), voice('s4')];
const log = (type: string, stepId: string, reason: string | null = null) => ({ type, reason, payload: { stepId } });

describe('the lead flow from the step log', () => {
  it('shows each step as it went: a text sent, a call and how it ended, a skipped step with why, what comes next', () => {
    const flow = flowFromLog(
      STEPS,
      [log('step_sent', 's1'), log('step_sent', 's2'), log('step_skipped', 's3', 'Only if the last call was not answered, and it was (connected)')],
      [{ status: 'completed', disposition: 'connected' }],
    );
    expect(flow?.map((s) => [s.state, s.outcome])).toEqual([
      ['done', 'SMS sent'],
      ['done', 'Answered'],
      ['skipped', 'Skipped'],
      ['current', null],
    ]);
    expect(flow?.[2].detail).toMatch(/it was \(connected\)/);
  });

  it('the AI chat replies do not count as strategy texts, unlike the old matching by count', () => {
    // Only the step log says which texts were steps; the chat's texts never reach it.
    const flow = flowFromLog(STEPS, [log('step_sent', 's1')], []);
    expect(flow?.map((s) => s.state)).toEqual(['done', 'current', 'pending', 'pending']);
  });

  it('a step being held shows as waiting with the reason, and a queued call before it is placed as queued', () => {
    const flow = flowFromLog(STEPS, [log('step_sent', 's1'), log('step_sent', 's2'), log('step_held', 's3', 'A call is still queued, ringing or live')], []);
    expect(flow?.[1]).toMatchObject({ state: 'current', outcome: 'Call queued' });
    expect(flow?.[2]).toMatchObject({ state: 'current', outcome: 'Waiting', detail: 'A call is still queued, ringing or live' });
  });

  it('a hold logged before the step went does not hide that it went', () => {
    const flow = flowFromLog([sms('s1'), sms('s2')], [log('step_sent', 's1'), log('step_held', 's2', 'Daily limit'), log('step_sent', 's2'), log('step_held', 's2', 'late')], []);
    expect(flow?.[1]).toMatchObject({ state: 'done', outcome: 'SMS sent' });
  });

  it('calls not answered read as such', () => {
    const flow = flowFromLog([voice('a'), voice('b')], [log('step_sent', 'a'), log('step_sent', 'b')], [
      { status: 'completed', disposition: 'voicemail' },
      { status: 'no_answer', disposition: 'rejected' },
    ]);
    expect(flow?.map((s) => [s.state, s.outcome])).toEqual([
      ['failed', 'Voicemail'],
      ['failed', 'Declined'],
    ]);
  });

  it('a call step gets the first call placed after it went, not a call from before (a callback, a manual call)', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min));
    const flow = flowFromLog([voice('a')], [{ ...log('step_sent', 'a'), createdAt: at(5) }], [
      { status: 'completed', disposition: 'connected', createdAt: at(1) },
      { status: 'completed', disposition: 'voicemail', createdAt: at(6) },
    ]);
    expect(flow?.[0].outcome).toBe('Voicemail');
  });

  it('a lead from before the step log is left to the old matching', () => {
    expect(flowFromLog(STEPS, [], [{ status: 'completed', disposition: null }])).toBeNull();
  });
});

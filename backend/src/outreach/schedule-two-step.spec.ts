import { describe, expect, it } from 'vitest';
import type { StrategyStep } from '@/telnyx/strategy-store.service';
import { awaitingWindowMs } from './schedule';

const MIN = 60_000;
const s = (channel: 'sms' | 'voice', value: number, unit: StrategyStep['after']['unit'] = 'minutes'): StrategyStep => ({ id: channel, channel, after: { value, unit } });

describe('awaitingWindowMs for a two-step strategy (waits add up)', () => {
  it('a call that starts 30 minutes in holds its slot window from then', () => {
    expect(awaitingWindowMs([s('voice', 30), s('sms', 5)], true)).toBe(35 * MIN);
  });
  it('a call after a text waits the text\'s start plus its own wait', () => {
    expect(awaitingWindowMs([s('sms', 10), s('voice', 2)], true)).toBe(17 * MIN);
  });
  it('an older strategy still reads each wait from enrolment', () => {
    expect(awaitingWindowMs([s('sms', 10), s('voice', 2)])).toBe(7 * MIN);
  });
});

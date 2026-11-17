import { describe, expect, it } from 'vitest';
import { cleanServiceAreas, coversArea, liveTransferSettings, transferToolWanted, withinWorkingHours } from './live-transfer';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, isAvailable: dayOfWeek >= 1 && dayOfWeek <= 5, startTime: '09:00', endTime: '18:00' }));

describe('live transfer rules', () => {
  it('defaults to off, two agents, 20 seconds each, and clamps what is out of range', () => {
    expect(liveTransferSettings(null)).toMatchObject({ enabled: false, ringSeconds: 20, agentsPerTransfer: 2, onHotLead: true, onRequest: true });
    expect(liveTransferSettings({ enabled: true, ringSeconds: 500, agentsPerTransfer: 0, holdMessage: '  ' })).toMatchObject({ ringSeconds: 20, agentsPerTransfer: 2 });
    expect(transferToolWanted(liveTransferSettings({ enabled: true, onHotLead: false, onRequest: false }))).toBe(false);
  });

  it('an agent covers the lead when one of their ZIPs or cities is in the lead’s location, or when either side has none', () => {
    expect(coversArea(['78704'], 'South Austin, TX 78704')).toBe(true);
    expect(coversArea(['austin'], 'South Austin, TX')).toBe(true);
    expect(coversArea(['round rock'], 'Round Rock TX')).toBe(true);
    expect(coversArea(['austin'], 'Houston, TX')).toBe(false);
    expect(coversArea(['787'], 'Austin 78704')).toBe(false);
    expect(coversArea([], 'Houston')).toBe(true);
    expect(coversArea(['austin'], null)).toBe(true);
    expect(cleanServiceAreas([' Austin ', 'austin', '', '78704'])).toEqual(['austin', '78704']);
  });

  it('reads working hours on the agent’s own clock', () => {
    // Monday 14:00 UTC is 09:00 in Chicago (CDT) and 10:00 in New York.
    const mondayNoonish = new Date('2026-06-01T14:00:00Z');
    expect(withinWorkingHours(WEEKDAYS, 'America/Chicago', mondayNoonish)).toBe(true);
    expect(withinWorkingHours(WEEKDAYS, 'America/Los_Angeles', mondayNoonish)).toBe(false); // 07:00
    expect(withinWorkingHours(WEEKDAYS, 'America/Chicago', new Date('2026-06-06T16:00:00Z'))).toBe(false); // Saturday
    const night = WEEKDAYS.map((d) => ({ ...d, isAvailable: true, startTime: '22:00', endTime: '06:00' }));
    expect(withinWorkingHours(night, 'UTC', new Date('2026-06-01T02:00:00Z'))).toBe(true);
    expect(withinWorkingHours(null, 'UTC')).toBe(false);
    expect(withinWorkingHours(WEEKDAYS, 'Not/AZone', mondayNoonish)).toBe(false);
  });
});

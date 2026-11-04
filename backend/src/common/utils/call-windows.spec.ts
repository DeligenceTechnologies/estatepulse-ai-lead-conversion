import { describe, expect, it } from 'vitest';
import { LEGAL_RULES, legalWindows } from './call-windows';
import type { Jurisdiction } from './lead-timezone';

const est = (country: string | null, region: string | null = null): Jurisdiction => ({ country, region, status: country ? 'estimated' : 'unknown' });

describe('the legal rules table', () => {
  it('is well formed: codes, days and HH:MM windows that start before they end', () => {
    for (const r of LEGAL_RULES) {
      expect(r.jurisdiction).toMatch(/^[A-Z]{2}(-[A-Z]{2})?$/);
      expect(r.days.length).toBeGreaterThan(0);
      for (const d of r.days) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(6);
      }
      if (r.window) {
        expect(r.window.start).toMatch(/^\d{2}:\d{2}$/);
        expect(r.window.end).toMatch(/^\d{2}:\d{2}$/);
        expect(r.window.start < r.window.end).toBe(true);
      }
      expect(r.source.length).toBeGreaterThan(3);
      expect(r.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('covers every day exactly once per jurisdiction', () => {
    const byCode = new Map<string, number[]>();
    for (const r of LEGAL_RULES) byCode.set(r.jurisdiction, [...(byCode.get(r.jurisdiction) ?? []), ...r.days]);
    for (const [code, days] of byCode) expect([...days].sort().join(), code).toBe('0,1,2,3,4,5,6');
  });
});

describe('legal windows for a day', () => {
  it('a US state adds its own window on top of the federal one', () => {
    const fl = legalWindows(est('US', 'FL'), 'America/New_York', 2);
    expect(fl.closedBy).toBeNull();
    expect(fl.quiet).toEqual([
      { hours: { start: '21:00', end: '08:00' }, rule: 'US' },
      { hours: { start: '20:00', end: '08:00' }, rule: 'US-FL' },
    ]);
  });

  it('Texas on a Sunday starts at noon; Rhode Island on a Sunday is closed', () => {
    expect(legalWindows(est('US', 'TX'), 'America/Chicago', 0).quiet.map((w) => w.hours)).toContainEqual({ start: '21:00', end: '12:00' });
    expect(legalWindows(est('US', 'RI'), 'America/New_York', 0).closedBy).toBe('US-RI');
  });

  it('Canada differs between weekdays and the weekend', () => {
    expect(legalWindows(est('CA', 'ON'), 'America/Toronto', 3).quiet).toEqual([{ hours: { start: '21:30', end: '09:00' }, rule: 'CA' }]);
    expect(legalWindows(est('CA', 'ON'), 'America/Toronto', 6).quiet).toEqual([{ hours: { start: '18:00', end: '10:00' }, rule: 'CA' }]);
  });

  it('a disputed or unknown jurisdiction in North America gets the US and Canadian rules together, elsewhere none', () => {
    const disputed: Jurisdiction = { country: 'CA', region: 'BC', status: 'conflict' };
    expect(legalWindows(disputed, 'America/Toronto', 6).quiet.map((w) => w.rule)).toEqual(['US', 'CA']);
    expect(legalWindows(est(null), 'America/Vancouver', 1).quiet.map((w) => w.rule)).toEqual(['US', 'CA']);
    expect(legalWindows(est(null), 'Asia/Kolkata', 1).quiet).toEqual([]);
  });

  it('a country without rules has no legal window', () => {
    expect(legalWindows(est('IN'), 'Asia/Kolkata', 1)).toEqual({ closedBy: null, quiet: [] });
  });
});

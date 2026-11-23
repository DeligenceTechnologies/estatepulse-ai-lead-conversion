import { describe, expect, it } from 'vitest';
import { buildRows, buildTotals, MANUAL_ROW_NAME, monthRange, ratio, type SourceCounts } from './roi-math';

const counts = (over: Partial<SourceCounts>): SourceCounts => ({
  sourceId: 'src-1',
  name: 'Zillow',
  provider: 'WEBHOOK',
  archived: false,
  leads: 0,
  contacted: 0,
  qualified: 0,
  booked: 0,
  held: 0,
  noShow: 0,
  won: 0,
  lost: 0,
  revenue: 0,
  spend: 0,
  commCost: 0,
  ...over,
});

describe('ratio', () => {
  it('is null when there is nothing to divide by', () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });
});

describe('buildRows', () => {
  it('works out rates and costs from spend plus communication cost', () => {
    const [row] = buildRows([counts({ leads: 40, contacted: 30, qualified: 10, booked: 5, held: 4, won: 2, spend: 1500, commCost: 200, revenue: 18000 })]);
    expect(row).toMatchObject({
      totalCost: 1700,
      contactRate: 0.75,
      qualificationRate: 0.25,
      costPerLead: 42.5,
      costPerAppointment: 340,
      costPerClosing: 850,
      spendEditable: true,
    });
  });

  it('a source with spend but no appointments or closings has no cost per either, not zero', () => {
    const [row] = buildRows([counts({ leads: 3, spend: 500 })]);
    expect(row.costPerAppointment).toBeNull();
    expect(row.costPerClosing).toBeNull();
    expect(row.costPerLead).toBe(166.67);
  });

  it('a source with spend and no leads at all still shows, with empty rates', () => {
    const [row] = buildRows([counts({ spend: 250 })]);
    expect(row).toMatchObject({ leads: 0, spend: 250, contactRate: null, costPerLead: null });
  });

  it('names the source-less row, puts it last and takes no spend for it', () => {
    const rows = buildRows([
      counts({ sourceId: null, name: null, provider: null, leads: 99 }),
      counts({ sourceId: 'a', name: 'Small', leads: 1 }),
      counts({ sourceId: 'b', name: 'Big', leads: 7 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Big', 'Small', MANUAL_ROW_NAME]);
    expect(rows[2].spendEditable).toBe(false);
  });

  it('an archived source keeps its history but takes no new spend', () => {
    const [row] = buildRows([counts({ archived: true, leads: 2 })]);
    expect(row.spendEditable).toBe(false);
  });
});

describe('buildTotals', () => {
  it('sums the rows and works the rates out again from the sums', () => {
    const rows = buildRows([
      counts({ sourceId: 'a', leads: 10, contacted: 5, booked: 1, won: 1, spend: 100, commCost: 10 }),
      counts({ sourceId: 'b', leads: 30, contacted: 25, booked: 3, won: 0, spend: 300, commCost: 30 }),
    ]);
    expect(buildTotals(rows)).toMatchObject({
      leads: 40,
      contacted: 30,
      contactRate: 0.75,
      spend: 400,
      commCost: 40,
      totalCost: 440,
      costPerAppointment: 110,
      costPerClosing: 440,
    });
  });

  it('with no rows every rate is empty', () => {
    expect(buildTotals([])).toMatchObject({ leads: 0, totalCost: 0, contactRate: null, costPerAppointment: null });
  });
});

describe('monthRange', () => {
  it('covers both months, ending at the first day after the last', () => {
    expect(monthRange('2026-11', '2026-11')).toEqual({ start: '2026-11-01', endExclusive: '2026-12-01', months: 1 });
    expect(monthRange('2026-10', '2026-12')).toEqual({ start: '2026-10-01', endExclusive: '2027-01-01', months: 3 });
  });

  it('rejects a backwards range, a malformed month and more than 24 months', () => {
    expect(() => monthRange('2026-12', '2026-11')).toThrow();
    expect(() => monthRange('2026-13', '2026-13')).toThrow();
    expect(() => monthRange('2026-1', '2026-02')).toThrow();
    expect(() => monthRange('2024-01', '2026-01')).toThrow();
    expect(monthRange('2024-02', '2026-01').months).toBe(24);
  });
});

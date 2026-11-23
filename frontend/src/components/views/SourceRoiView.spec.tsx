import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoiNumbers, RoiReport, RoiRow } from '../../utils/sourceRoiApi';
import { dealLabel } from '../leads/DealOutcomeControl';
import { changedRates, parseRate } from '../roi/CostRatesEditor';
import { canToggleNoShow, wasDue } from '../roi/NoShowButton';

/**
 * What the report renders for each state of its one read. The read itself is
 * useLiveQuery (tested on its own), so it is replaced here with a fixed result.
 */
const query = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('../../lib/useLiveQuery', () => ({ useLiveQuery: () => query.result }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

import { isMonth, monthLabel, monthOf, monthsBefore, SourceRoiReport } from './SourceRoiView';

const numbers = (over: Partial<RoiNumbers> = {}): RoiNumbers => ({
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
  totalCost: 0,
  contactRate: null,
  qualificationRate: null,
  costPerLead: null,
  costPerAppointment: null,
  costPerClosing: null,
  ...over,
});

const row = (over: Partial<RoiRow>): RoiRow => ({
  ...numbers(),
  sourceId: 's1',
  name: 'Zillow',
  provider: 'WEBHOOK',
  archived: false,
  spendEditable: true,
  ...over,
});

const ZILLOW = row({
  leads: 40,
  contacted: 30,
  qualified: 10,
  booked: 5,
  held: 4,
  noShow: 1,
  won: 2,
  revenue: 18000,
  spend: 1500,
  commCost: 200,
  totalCost: 1700,
  contactRate: 0.75,
  qualificationRate: 0.25,
  costPerAppointment: 340,
  costPerClosing: 850,
});
const FORMS = row({ sourceId: 's2', name: 'Google Forms', leads: 20, contacted: 10, booked: 0, spend: 90, totalCost: 90, contactRate: 0.5 });
const MANUAL = row({ sourceId: null, name: 'Added manually', provider: null, spendEditable: false, leads: 3 });

const report = (rows: RoiRow[], totals: Partial<RoiNumbers> = {}): RoiReport => ({
  // The page opens on the current month.
  from: monthOf(new Date()),
  to: monthOf(new Date()),
  months: 1,
  currency: 'USD',
  rows,
  totals: numbers(totals),
  appointmentsTrackedSince: '2026-09-01T00:00:00.000Z',
});

const loaded = (data: RoiReport | null, over: Record<string, unknown> = {}) => {
  query.result = { data, error: null, refreshing: false, stale: false, refresh: () => undefined, invalidate: () => undefined, ...over };
};

const render = (canEdit = true) => renderToString(<SourceRoiReport canEdit={canEdit} />);

beforeEach(() => loaded(null));

describe('SourceRoiReport', () => {
  it('shows each source with its counts, rates and costs', () => {
    loaded(report([ZILLOW, FORMS], { leads: 60, booked: 5, costPerAppointment: 358, totalCost: 1790 }));
    const html = render();
    expect(html).toContain('Zillow');
    expect(html).toContain('75%');
    expect(html).toContain('$340');
    expect(html).toContain('$850');
    expect(html).toContain('$18,000');
    expect(html).toContain('1 no-show');
    expect(html).toContain('All sources');
    expect(html).toContain('$358');
  });

  it('a source with no appointments shows a dash for cost per appointment, never $0', () => {
    loaded(report([FORMS]));
    const html = render(false);
    // Cost per appointment and cost per closing are the two emphasised cells.
    const emphasised = [...html.matchAll(/font-semibold text-white">([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(emphasised).toEqual(['—', '—']);
  });

  it('offers a spend box per source for a single month, but not for leads with no source', () => {
    loaded(report([ZILLOW, MANUAL]));
    const html = render();
    expect(html).toContain(`Marketing spend for Zillow in ${monthLabel(monthOf(new Date()))}`);
    expect(html).not.toContain('Marketing spend for Added manually');
    expect(html).toContain('No source to spend on');
  });

  it('someone who may only read sees the amounts, with no boxes', () => {
    loaded(report([ZILLOW]));
    const html = render(false);
    expect(html).not.toContain('<input aria-label="Marketing spend');
    expect(html).toContain('$1,500');
  });

  it('says the cost is an estimate and since when appointments are counted', () => {
    loaded(report([ZILLOW]));
    const html = render();
    expect(html).toContain('AI and communication cost is an estimate.');
    expect(html).toContain('2026');
  });

  it('with no sources at all, says where to connect one', () => {
    loaded(report([]));
    expect(render()).toContain('No lead sources yet.');
  });

  it('while the first read runs, shows placeholders and no numbers', () => {
    const html = render();
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('All sources');
  });

  it('a failed read with nothing to show offers a retry; with data on screen it only says the data is old', () => {
    loaded(null, { error: 'Cannot reach the server.' });
    expect(render()).toContain('Could not load Source ROI');
    loaded(report([ZILLOW]), { error: 'Cannot reach the server.', stale: true });
    const html = render();
    expect(html).toContain('Showing the last data we loaded.');
    expect(html).not.toContain('Could not load Source ROI');
    expect(html).toContain('Zillow');
  });
});

describe('answers for other months', () => {
  it('are not shown: the page waits for the months that are picked', () => {
    loaded({ ...report([ZILLOW]), from: '2020-01', to: '2020-02' });
    const html = render();
    expect(html).not.toContain('Zillow');
    expect(html).not.toContain('Marketing spend for');
    expect(html).toContain('animate-pulse');
  });
});

describe('month helpers', () => {
  it('only a whole YYYY-MM is a month', () => {
    expect(isMonth('2026-11')).toBe(true);
    for (const bad of ['', '2', '2026', '2026-1', '2026-13', '2026-11-01']) expect(isMonth(bad)).toBe(false);
  });

  it('steps back across a year boundary', () => {
    expect(monthsBefore('2026-11', 2)).toBe('2026-09');
    expect(monthsBefore('2026-01', 2)).toBe('2025-11');
  });

  it('names a month', () => {
    expect(monthLabel('2026-11')).toBe('November 2026');
  });
});

describe('the small controls', () => {
  it('the deal button reads the outcome', () => {
    expect(dealLabel({ outcome: null, value: null, closedAt: null })).toBe('Mark outcome');
    expect(dealLabel({ outcome: 'won', value: 12000, closedAt: null })).toBe('Deal won · $12,000');
    expect(dealLabel({ outcome: 'won', value: null, closedAt: null })).toBe('Deal won');
    expect(dealLabel({ outcome: 'lost', value: null, closedAt: null })).toBe('Deal lost');
  });

  it('only an appointment that was due to happen can be a no-show', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(wasDue({ status: 'scheduled', endTime: '2026-11-20T11:00:00Z' }, now)).toBe(true);
    expect(wasDue({ status: 'scheduled', endTime: '2026-11-20T13:00:00Z' }, now)).toBe(false);
    expect(wasDue({ status: 'cancelled', endTime: '2026-11-20T11:00:00Z' }, now)).toBe(false);
  });

  it('saving rates sends only the ones that changed, so an untouched default stays a default', () => {
    const saved = { callRatePerMinute: 0.09, smsRatePerSegment: 0.008 };
    expect(changedRates(saved, 0.12, 0.008)).toEqual({ callRatePerMinute: 0.12 });
    expect(changedRates(saved, 0.09, 0.008)).toEqual({});
  });

  it('a no-show can be taken back even after the meeting was cancelled', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(canToggleNoShow({ status: 'cancelled', endTime: '2026-11-20T11:00:00Z', noShowAt: '2026-11-20T11:30:00Z' }, now)).toBe(true);
    expect(canToggleNoShow({ status: 'cancelled', endTime: '2026-11-20T11:00:00Z', noShowAt: null }, now)).toBe(false);
  });

  it('a rate is a plain amount of at most four decimals', () => {
    expect(parseRate('0.09')).toBe(0.09);
    expect(parseRate('$0.0085')).toBe(0.0085);
    expect(parseRate('0.00001')).toBeUndefined();
    expect(parseRate('')).toBeUndefined();
    expect(parseRate('-1')).toBeUndefined();
  });
});

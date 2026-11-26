import { describe, expect, it } from 'vitest';
import { newlyCanceled } from './calendar-sync.service';

const before = new Map([
  ['m-booked', { status: 'scheduled' as const, leadId: 'lead-maria' }],
  ['m-pending', { status: 'pending' as const, leadId: 'lead-john' }],
  ['m-old-cancel', { status: 'canceled' as const, leadId: 'lead-priya' }],
  ['m-no-lead', { status: 'scheduled' as const, leadId: null }],
]);

describe('a meeting canceled since the last sync', () => {
  it('names the lead of a meeting that was on the calendar and is canceled now', () => {
    const rows = [
      { externalId: 'm-booked', status: 'canceled' as const },
      { externalId: 'm-pending', status: 'canceled' as const },
    ];
    expect([...newlyCanceled(rows, before)].sort()).toEqual(['lead-john', 'lead-maria']);
  });

  it('ignores one canceled before, one first seen already canceled, one with no lead, and one still on', () => {
    const rows = [
      { externalId: 'm-old-cancel', status: 'canceled' as const },
      { externalId: 'm-new', status: 'canceled' as const },
      { externalId: 'm-no-lead', status: 'canceled' as const },
      { externalId: 'm-booked', status: 'scheduled' as const },
    ];
    expect(newlyCanceled(rows, before).size).toBe(0);
  });
});

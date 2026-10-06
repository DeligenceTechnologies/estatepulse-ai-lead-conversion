import { describe, expect, it } from 'vitest';
import {
  AUTO_FROM,
  INACTIVE_STATUSES,
  LEAD_STATUSES,
  LeadStatus,
  OUTCOME_STATUSES,
  normalizeLeadStatus,
  normalizeStatusCounts,
  statusFilterValues,
} from './domain';

describe('lead status v2', () => {
  it('has exactly the 13 statuses of leads_status_check', () => {
    expect([...LEAD_STATUSES]).toEqual([
      'new',
      'contacting',
      'contacted',
      'engaged',
      'qualified',
      'appointment_requested',
      'appointment_booked',
      'follow_up',
      'nurture',
      'not_interested',
      'dnc',
      'invalid',
      'closed',
    ]);
  });

  it('reads legacy values under their current name', () => {
    expect(normalizeLeadStatus('booked')).toBe('appointment_booked');
    expect(normalizeLeadStatus('lost')).toBe('not_interested');
    expect(normalizeLeadStatus('lost', true)).toBe('dnc');
    expect(normalizeLeadStatus('engaged')).toBe('engaged');
    expect(normalizeLeadStatus(null)).toBe('new');
  });

  it('folds legacy rows into the current counts', () => {
    expect(
      normalizeStatusCounts([
        { status: 'booked', _count: { _all: 2 } },
        { status: 'appointment_booked', _count: { _all: 1 } },
        { status: 'lost', dnc_status: true, _count: { _all: 3 } },
        { status: 'lost', dnc_status: false, _count: { _all: 4 } },
      ]),
    ).toEqual({ appointment_booked: 3, dnc: 3, not_interested: 4 });
  });

  it('filters match the legacy spelling too', () => {
    expect(statusFilterValues('appointment_booked')).toEqual(['appointment_booked', 'booked']);
    expect(statusFilterValues('not_interested')).toEqual(['not_interested', 'lost']);
    expect(statusFilterValues('engaged')).toEqual(['engaged']);
  });

  it('never moves a lead backwards automatically', () => {
    // A late call.answered must not undo a qualification or a booking.
    expect(AUTO_FROM[LeadStatus.CONTACTED]).not.toContain(LeadStatus.QUALIFIED);
    expect(AUTO_FROM[LeadStatus.CONTACTED]).not.toContain(LeadStatus.ENGAGED);
    expect(AUTO_FROM[LeadStatus.CONTACTING]).toEqual([LeadStatus.NEW]);
    for (const from of Object.values(AUTO_FROM).flat()) {
      expect(OUTCOME_STATUSES).not.toContain(from);
    }
  });

  it('stops automation on every outcome, legacy included', () => {
    for (const s of ['qualified', 'appointment_requested', 'appointment_booked', 'not_interested', 'dnc', 'invalid', 'closed', 'booked', 'lost']) {
      expect(OUTCOME_STATUSES).toContain(s);
    }
    for (const s of INACTIVE_STATUSES) expect(OUTCOME_STATUSES).toContain(s);
  });
});

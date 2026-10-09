import { describe, expect, it } from 'vitest';
import {
  AUTO_FROM,
  FOLLOW_UP_REASONS,
  INACTIVE_STATUSES,
  IN_STRATEGY_STATUSES,
  LEAD_STATUSES,
  LeadStatus,
  OUTCOME_STATUSES,
  REPLY_FROM,
  normalizeFollowUpReason,
  normalizeLeadStatus,
  normalizeStatusCounts,
  statusFilterValues,
} from './domain';

describe('lead status v3', () => {
  it('has exactly the 9 statuses of leads_status_check', () => {
    expect([...LEAD_STATUSES]).toEqual([
      'new',
      'contacting',
      'follow_up',
      'interested',
      'appointment_requested',
      'appointment_booked',
      'not_interested',
      'closed',
      'invalid',
    ]);
  });

  it('has exactly the 5 follow-up reasons of leads_follow_up_reason_check', () => {
    expect([...FOLLOW_UP_REASONS]).toEqual(['no_answer', 'not_ready', 'callback_requested', 'needs_time', 'other']);
  });

  it('reads retired values under their current name', () => {
    expect(normalizeLeadStatus('booked')).toBe('appointment_booked');
    expect(normalizeLeadStatus('lost')).toBe('not_interested');
    expect(normalizeLeadStatus('dnc')).toBe('not_interested');
    expect(normalizeLeadStatus('contacted')).toBe('contacting');
    expect(normalizeLeadStatus('engaged')).toBe('contacting');
    expect(normalizeLeadStatus('qualified')).toBe('interested');
    expect(normalizeLeadStatus('nurture')).toBe('follow_up');
    expect(normalizeLeadStatus(null)).toBe('new');
  });

  it('shows a follow-up reason only for a follow-up lead', () => {
    expect(normalizeFollowUpReason('follow_up', 'no_answer')).toBe('no_answer');
    expect(normalizeFollowUpReason('follow_up', null)).toBe('other');
    expect(normalizeFollowUpReason('follow_up', 'bogus')).toBe('other');
    expect(normalizeFollowUpReason('nurture', null)).toBe('not_ready');
    // A stale reason left behind by a later status change never surfaces.
    expect(normalizeFollowUpReason('interested', 'no_answer')).toBeNull();
  });

  it('folds retired rows into the current counts', () => {
    expect(
      normalizeStatusCounts([
        { status: 'booked', _count: { _all: 2 } },
        { status: 'appointment_booked', _count: { _all: 1 } },
        { status: 'lost', _count: { _all: 3 } },
        { status: 'dnc', _count: { _all: 4 } },
        { status: 'nurture', _count: { _all: 5 } },
      ]),
    ).toEqual({ appointment_booked: 3, not_interested: 7, follow_up: 5 });
  });

  it('filters match the retired spellings too', () => {
    expect(statusFilterValues('appointment_booked')).toEqual(['appointment_booked', 'booked']);
    expect(statusFilterValues('not_interested')).toEqual(['not_interested', 'lost', 'dnc']);
    expect(statusFilterValues('contacting')).toEqual(['contacting', 'contacted', 'engaged']);
    expect(statusFilterValues('follow_up')).toEqual(['follow_up', 'nurture']);
    expect(statusFilterValues('new')).toEqual(['new']);
  });

  it('never moves a lead backwards automatically', () => {
    expect(AUTO_FROM[LeadStatus.CONTACTING]).toEqual([LeadStatus.NEW]);
    for (const from of [...Object.values(AUTO_FROM).flat(), ...REPLY_FROM]) {
      expect(OUTCOME_STATUSES).not.toContain(from);
    }
  });

  it('keeps retired in-strategy spellings in the strategy', () => {
    for (const s of ['new', 'contacting', 'contacted', 'engaged']) expect(IN_STRATEGY_STATUSES).toContain(s);
  });

  it('stops automation on every outcome, retired spellings included', () => {
    for (const s of [
      'interested',
      'qualified',
      'appointment_requested',
      'appointment_booked',
      'not_interested',
      'dnc',
      'invalid',
      'closed',
      'booked',
      'lost',
    ]) {
      expect(OUTCOME_STATUSES).toContain(s);
    }
    for (const s of INACTIVE_STATUSES) expect(OUTCOME_STATUSES).toContain(s);
  });
});

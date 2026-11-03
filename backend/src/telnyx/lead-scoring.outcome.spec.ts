import { describe, expect, it } from 'vitest';
import type { Extraction } from './lead-scoring';
import { endingOutcome } from './lead-scoring.service';

const call = (over: Partial<Extraction>): Extraction => ({
  timeline: 'unknown',
  budget_identified: false,
  location_identified: false,
  pre_approved: false,
  appointment_requested: false,
  high_engagement: false,
  not_interested: false,
  invalid_lead: false,
  human_requested: false,
  callback_requested: false,
  summary: '',
  ...over,
});

describe('endingOutcome', () => {
  it('ends the outreach on a wrong number, whatever else was said', () => {
    expect(endingOutcome(call({ invalid_lead: true, appointment_requested: true }))).toBe('invalid');
  });

  it('ends it on a plain "not interested"', () => {
    expect(endingOutcome(call({ not_interested: true }))).toBe('not_interested');
  });

  it('leaves a mixed answer to the score: "not now, call me later" or "no, but show me one house"', () => {
    expect(endingOutcome(call({ not_interested: true, callback_requested: true }))).toBeNull();
    expect(endingOutcome(call({ not_interested: true, appointment_requested: true }))).toBeNull();
    expect(endingOutcome(call({ high_engagement: true }))).toBeNull();
  });
});

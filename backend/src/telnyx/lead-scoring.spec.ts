import { describe, expect, it } from 'vitest';
import { leadDetailsFrom, parseExtraction, scoreLead, thresholdsSchema, type Extraction } from './lead-scoring';

const base: Extraction = {
  timeline: 'unknown',
  budget_identified: false,
  location_identified: false,
  pre_approved: false,
  appointment_requested: false,
  high_engagement: false,
  not_interested: false,
  invalid_lead: false,
  human_requested: false,
  summary: 'A buyer.',
};
const x = (over: Partial<Extraction>): Extraction => ({ ...base, ...over });

describe('scoreLead', () => {
  it('scores nothing said as 0 and cold, with no reasons', () => {
    expect(scoreLead(base)).toEqual({ score: 0, temperature: 'cold', reasons: [], override: null });
  });

  it('awards each timeline bucket its points', () => {
    expect(scoreLead(x({ timeline: 'within_30_days' })).score).toBe(25);
    expect(scoreLead(x({ timeline: '1_3_months' })).score).toBe(20);
    expect(scoreLead(x({ timeline: '3_6_months' })).score).toBe(10);
    expect(scoreLead(x({ timeline: 'over_6_months' })).score).toBe(0);
  });

  it('adds every fact with a readable reason', () => {
    const r = scoreLead(
      x({
        timeline: '1_3_months',
        budget_identified: true,
        location_identified: true,
        pre_approved: true,
        appointment_requested: true,
        high_engagement: true,
      }),
    );
    expect(r.score).toBe(85);
    expect(r.temperature).toBe('hot');
    expect(r.reasons).toEqual([
      { label: 'Buying within 1–3 months', points: 20 },
      { label: 'Budget identified', points: 10 },
      { label: 'Location identified', points: 10 },
      { label: 'Pre-approved', points: 15 },
      { label: 'Appointment requested', points: 20 },
      { label: 'High engagement', points: 10 },
    ]);
  });

  it('uses the default 75 / 45 thresholds at their boundaries', () => {
    // 25 + 10 + 10 = 45 -> warm exactly at the warm threshold
    expect(scoreLead(x({ timeline: 'within_30_days', budget_identified: true, location_identified: true })).temperature).toBe('warm');
    // 25 + 10 + 10 + 20 + 10 = 75 -> hot exactly at the hot threshold
    expect(
      scoreLead(
        x({ timeline: 'within_30_days', budget_identified: true, location_identified: true, appointment_requested: true, high_engagement: true }),
      ),
    ).toMatchObject({ score: 75, temperature: 'hot' });
    // 44 is not reachable with the table, 35 is: cold
    expect(scoreLead(x({ timeline: 'within_30_days', budget_identified: true })).temperature).toBe('cold');
  });

  it('applies the office thresholds instead of the defaults', () => {
    const facts = x({ timeline: 'within_30_days', budget_identified: true }); // 35
    expect(scoreLead(facts, { hot: 30, warm: 10 }).temperature).toBe('hot');
    expect(scoreLead(facts, { hot: 90, warm: 30 }).temperature).toBe('warm');
  });

  it('subtracts not-interested and clamps at 0', () => {
    const r = scoreLead(x({ timeline: '1_3_months', not_interested: true }));
    expect(r.score).toBe(0);
    expect(r.reasons).toContainEqual({ label: 'Not interested', points: -30 });
  });

  it('an invalid lead is 0 and cold whatever else was said', () => {
    const r = scoreLead(x({ timeline: 'within_30_days', pre_approved: true, appointment_requested: true, invalid_lead: true }));
    expect(r).toMatchObject({ score: 0, temperature: 'cold' });
  });

  it('never exceeds 100', () => {
    const r = scoreLead(
      x({
        timeline: 'within_30_days',
        budget_identified: true,
        location_identified: true,
        pre_approved: true,
        appointment_requested: true,
        high_engagement: true,
      }),
    );
    expect(r.score).toBe(90);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('asking for a person makes the lead hot, and says why', () => {
    const r = scoreLead(x({ human_requested: true }));
    expect(r.score).toBe(0);
    expect(r.temperature).toBe('hot');
    expect(r.override).toMatch(/person/);
  });

  it('asking for a person does not promote an invalid lead', () => {
    expect(scoreLead(x({ human_requested: true, invalid_lead: true })).temperature).toBe('cold');
  });

  it('is deterministic: the same facts always give the same result', () => {
    const facts = x({ timeline: '3_6_months', pre_approved: true, high_engagement: true });
    expect(scoreLead(facts)).toEqual(scoreLead(facts));
  });
});

describe('parseExtraction', () => {
  it('accepts a JSON string, as an Insight returns it', () => {
    expect(parseExtraction(JSON.stringify(base))).toEqual(base);
  });

  it('accepts an already-parsed object', () => {
    expect(parseExtraction(base)).toEqual(base);
  });

  it('rejects malformed JSON, missing fields and unknown timelines', () => {
    expect(parseExtraction('{not json')).toBeNull();
    expect(parseExtraction({ ...base, pre_approved: undefined })).toBeNull();
    expect(parseExtraction({ ...base, timeline: 'next week' })).toBeNull();
    expect(parseExtraction('Free-text summary from another insight')).toBeNull();
  });
});

describe('thresholdsSchema', () => {
  it('accepts warm below hot within 1–100', () => {
    expect(thresholdsSchema.safeParse({ hotThreshold: 75, warmThreshold: 45 }).success).toBe(true);
  });

  it('rejects warm at or above hot, out-of-range, fractional and extra fields', () => {
    expect(thresholdsSchema.safeParse({ hotThreshold: 50, warmThreshold: 50 }).success).toBe(false);
    expect(thresholdsSchema.safeParse({ hotThreshold: 101, warmThreshold: 45 }).success).toBe(false);
    expect(thresholdsSchema.safeParse({ hotThreshold: 75, warmThreshold: 0 }).success).toBe(false);
    expect(thresholdsSchema.safeParse({ hotThreshold: 75.5, warmThreshold: 45 }).success).toBe(false);
    expect(thresholdsSchema.safeParse({ hotThreshold: 75, warmThreshold: 45, organizationId: 'x' }).success).toBe(false);
  });
});

describe('leadDetailsFrom', () => {
  it('turns what the caller said into lead columns', () => {
    expect(
      leadDetailsFrom(
        x({
          timeline: '1_3_months',
          budget_min: 150000,
          budget_max: 220000,
          location: '  Austin, TX ',
          bedrooms: 4,
          financing: 'pre_approved',
          motivation: 'relocating for work',
        }),
      ),
    ).toEqual({
      min_budget: 150000,
      max_budget: 220000,
      location: 'Austin, TX',
      bedrooms: 4,
      timeline: '1–3 months',
      financing_status: 'Pre-approved',
      all_cash: false,
      motivation: 'relocating for work',
    });
  });

  it('writes nothing the caller did not say — no blanking of existing details', () => {
    expect(leadDetailsFrom(base)).toEqual({});
    expect(leadDetailsFrom(x({ location: '   ', financing: 'unknown', budget_min: null }))).toEqual({});
  });

  it('marks a cash buyer, and keeps a single budget figure as the maximum', () => {
    expect(leadDetailsFrom(x({ financing: 'cash', budget_max: 500000 }))).toEqual({
      financing_status: 'Cash buyer',
      all_cash: true,
      max_budget: 500000,
    });
  });

  it('puts a reversed budget range the right way round', () => {
    expect(leadDetailsFrom(x({ budget_min: 300000, budget_max: 200000 }))).toMatchObject({ min_budget: 200000, max_budget: 300000 });
  });

  it('ignores a motivation that is just a token, not something the caller said', () => {
    expect(leadDetailsFrom(x({ motivation: 'high_engagement' }))).toEqual({});
  });

  it('still parses a result from before these fields existed', () => {
    const old = { ...base } as Record<string, unknown>;
    expect(parseExtraction(JSON.stringify(old))).not.toBeNull();
  });
});


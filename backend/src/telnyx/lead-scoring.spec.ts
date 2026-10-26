import { beforeEach, describe, expect, it, vi } from 'vitest';
import { leadDetailsFrom, parseExtraction, scoreLead, type Extraction } from './lead-scoring';
import { LeadScoringService } from './lead-scoring.service';

/** Characterization: the points behind a lead's temperature, and when a scored call moves the lead. */

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
  callback_requested: null,
  summary: 'A buyer.',
  budget_min: null,
  budget_max: null,
  location: null,
  bedrooms: null,
  financing: null,
  motivation: null,
};

describe('scoreLead', () => {
  it('adds the points of every signal the caller gave', () => {
    const r = scoreLead({ ...base, timeline: 'within_30_days', budget_identified: true, location_identified: true, pre_approved: true, appointment_requested: true, high_engagement: true });
    expect(r.score).toBe(90);
    expect(r.temperature).toBe('hot');
    expect(r.reasons.map((x) => x.points)).toEqual([25, 10, 10, 15, 20, 10]);
  });

  it('uses the thresholds: warm at 45, hot at 75 by default, or the org’s own', () => {
    const warm = { ...base, timeline: '1_3_months' as const, budget_identified: true, location_identified: true, high_engagement: true };
    expect(scoreLead(warm).score).toBe(50);
    expect(scoreLead(warm).temperature).toBe('warm');
    expect(scoreLead(warm, { hot: 50, warm: 20 }).temperature).toBe('hot');
    expect(scoreLead(base).temperature).toBe('cold');
  });

  it('never goes below 0', () => {
    expect(scoreLead({ ...base, invalid_lead: true, not_interested: true }).score).toBe(0);
  });

  it('routes a caller who asked for a person as hot, unless the lead is invalid', () => {
    const asked = scoreLead({ ...base, human_requested: true });
    expect(asked.temperature).toBe('hot');
    expect(asked.override).toMatch(/speak with a person/);
    expect(scoreLead({ ...base, human_requested: true, invalid_lead: true }).temperature).toBe('cold');
  });
});

describe('leadDetailsFrom', () => {
  it('swaps a reversed budget, maps timeline and financing to words, and keeps a real motivation only', () => {
    expect(
      leadDetailsFrom({ ...base, budget_min: 500000, budget_max: 300000, timeline: '3_6_months', financing: 'cash', location: ' Austin ', bedrooms: 3, motivation: 'relocating for work' }),
    ).toEqual({ minBudget: 300000, maxBudget: 500000, timeline: '3–6 months', financingStatus: 'Cash buyer', location: 'Austin', bedrooms: 3, motivation: 'relocating for work' });
    expect(leadDetailsFrom({ ...base, motivation: 'engaged' })).toEqual({});
  });
});

describe('parseExtraction', () => {
  it('accepts JSON text or an object, and refuses anything off-schema', () => {
    expect(parseExtraction(JSON.stringify(base))).toEqual(base);
    expect(parseExtraction(base)).toEqual(base);
    expect(parseExtraction('not json')).toBeNull();
    expect(parseExtraction({ ...base, timeline: 'soon' })).toBeNull();
  });
});

describe('LeadScoringService.onInsightsGenerated', () => {
  const call = { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', extractedIntel: null, handoffRequested: false };
  const payload = (x: Extraction) => ({ results: [{ result: 'garbage' }, { result: JSON.stringify(x) }] });
  const delivery = { signature: undefined, timestamp: undefined, rawBody: undefined };

  function setup(opts: { latestId?: string; status?: string; publicKey?: string } = {}) {
    const prisma = {
      call: {
        findFirst: vi.fn().mockResolvedValueOnce(call).mockResolvedValueOnce({ id: opts.latestId ?? 'call-1' }),
        update: vi.fn(),
      },
      organizationSetting: { findUnique: vi.fn().mockResolvedValue({ leadHotThreshold: 75, leadWarmThreshold: 45 }) },
      lead: { findFirst: vi.fn().mockResolvedValue({ status: opts.status ?? 'contacting', dncStatus: false }), update: vi.fn() },
    };
    const creds = { getCreds: vi.fn().mockResolvedValue({ publicKey: opts.publicKey ?? '' }) };
    const engine = { qualified: vi.fn() };
    const service = new LeadScoringService(prisma as any, creds as any, {} as any, engine as any);
    return { service, prisma, engine };
  }

  beforeEach(() => vi.clearAllMocks());

  it('stores the qualification on the call, updates the lead and hands it to the engine', async () => {
    const { service, prisma, engine } = setup();
    const x = { ...base, timeline: 'within_30_days' as const, pre_approved: true, appointment_requested: true, high_engagement: true, budget_identified: true, location: 'Austin', callback_requested: true };
    await service.onInsightsGenerated('v3:cc-1', payload(x), delivery);
    expect(prisma.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: {
        extractedIntel: { qualification: expect.objectContaining({ source: 'telnyx_insights', score: 80, temperature: 'hot', extraction: x }) },
        aiSummary: 'A buyer.',
        handoffRequested: false,
      },
    });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { score: 80, location: 'Austin', timeline: 'Within 30 days' } });
    expect(engine.qualified).toHaveBeenCalledWith('org-1', 'lead-1', 'hot', expect.stringMatching(/^HOT — 80\./), { callbackRequested: true });
  });

  it('leaves the lead alone when a newer call exists', async () => {
    const { service, prisma, engine } = setup({ latestId: 'call-2' });
    await service.onInsightsGenerated('v3:cc-1', payload(base), delivery);
    expect(prisma.call.update).toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('only refreshes the temperature of a lead past an outcome', async () => {
    const { service, prisma, engine } = setup({ status: 'appointment_booked' });
    await service.onInsightsGenerated('v3:cc-1', payload(base), delivery);
    expect(prisma.lead.update).toHaveBeenLastCalledWith({ where: { id: 'lead-1' }, data: { temperature: 'cold' } });
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('ignores an unsigned result when the account has a public key', async () => {
    const { service, prisma } = setup({ publicKey: Buffer.alloc(32).toString('base64') });
    await service.onInsightsGenerated('v3:cc-1', payload(base), delivery);
    expect(prisma.call.update).not.toHaveBeenCalled();
  });
});

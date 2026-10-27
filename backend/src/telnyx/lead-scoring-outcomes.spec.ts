import { describe, expect, it, vi } from 'vitest';
import { LeadScoringService } from './lead-scoring.service';
import type { Extraction } from './lead-scoring';

/** What a scored call does to the lead when the caller says no, says wrong number, or says stop calling. */

const ORG = 'org-1';
const LEAD = 'lead-1';

const extraction = (over: Partial<Extraction>): Extraction => ({
  reached_person: true,
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
  summary: 'Short call.',
  ...over,
});

function setup(x: Extraction, lead: Record<string, unknown> = {}) {
  const call = { id: 'call-1', orgId: ORG, leadId: LEAD, transcript: 'Agent: hi…', extractedIntel: null, handoffRequested: false };
  const prisma = {
    call: { findFirst: vi.fn().mockResolvedValue(call), update: vi.fn().mockResolvedValue({}) },
    lead: { findFirst: vi.fn().mockResolvedValue({ status: 'contacting', dncStatus: false, ...lead }), update: vi.fn().mockResolvedValue({}) },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ leadHotThreshold: 75, leadWarmThreshold: 45 }) },
  };
  const insights = { extractFromTranscript: vi.fn().mockResolvedValue(x) };
  const engine = { qualified: vi.fn(), setStatus: vi.fn(), endJourney: vi.fn() };
  const scoring = new LeadScoringService(prisma as any, {} as any, insights as any, engine as any);
  return { score: () => scoring.classifyCall(ORG, 'call-1'), engine, prisma };
}

describe('LeadScoringService: a call that ends the journey', () => {
  it('"not interested" closes the lead as not interested: no nurture, no enrolment', async () => {
    const { score, engine } = setup(extraction({ not_interested: true }));
    await score();
    expect(engine.endJourney).toHaveBeenCalledWith(ORG, LEAD, 'not_interested', expect.stringContaining('not interested'));
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('"not interested" next to a request for a meeting or a person is not a no: scored as usual', async () => {
    const { score, engine } = setup(extraction({ not_interested: true, appointment_requested: true }));
    await score();
    expect(engine.qualified).toHaveBeenCalled();
    expect(engine.endJourney).not.toHaveBeenCalled();
  });

  it('a wrong number closes the lead as invalid', async () => {
    const { score, engine } = setup(extraction({ invalid_lead: true }));
    await score();
    expect(engine.endJourney).toHaveBeenCalledWith(ORG, LEAD, 'invalid', expect.stringContaining('Wrong number'));
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('"stop calling me" sets do-not-contact, even on a lead already booked', async () => {
    for (const status of ['contacting', 'appointment_booked']) {
      const { score, engine } = setup(extraction({ do_not_contact: true, not_interested: true }), { status });
      await score();
      expect(engine.setStatus).toHaveBeenCalledWith(ORG, LEAD, 'not_interested', 'Asked on the call not to be contacted again', { optOut: true });
      expect(engine.qualified).not.toHaveBeenCalled();
      expect(engine.endJourney).not.toHaveBeenCalled();
    }
  });

  it('a lead already opted out is never moved again', async () => {
    const { score, engine } = setup(extraction({ do_not_contact: true }), { dncStatus: true, status: 'not_interested' });
    await score();
    expect(engine.setStatus).not.toHaveBeenCalled();
  });
});

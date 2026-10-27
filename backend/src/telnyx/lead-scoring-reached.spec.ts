import { describe, expect, it, vi } from 'vitest';
import { LeadScoringService } from './lead-scoring.service';
import type { Extraction } from './lead-scoring';

/** A call whose analysis says nobody was reached (voicemail, a phone menu) is recorded, but never moves the lead. */

const ORG = 'org-1';
const LEAD = 'lead-1';

const extraction = (over: Partial<Extraction>): Extraction => ({
  reached_person: true,
  timeline: '1_3_months',
  budget_identified: true,
  location_identified: true,
  pre_approved: false,
  appointment_requested: false,
  high_engagement: true,
  not_interested: false,
  invalid_lead: false,
  human_requested: false,
  callback_requested: false,
  summary: 'Looking in Austin.',
  ...over,
});

function setup(x: Extraction) {
  const call = { id: 'call-1', orgId: ORG, leadId: LEAD, transcript: 'Agent: hi…', extractedIntel: null, handoffRequested: false };
  const prisma = {
    call: { findFirst: vi.fn().mockResolvedValue(call), update: vi.fn().mockResolvedValue({}) },
    lead: { findFirst: vi.fn().mockResolvedValue({ status: 'contacting', dncStatus: false }), update: vi.fn().mockResolvedValue({}) },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ leadHotThreshold: 75, leadWarmThreshold: 45 }) },
  };
  const insights = { extractFromTranscript: vi.fn().mockResolvedValue(x) };
  const engine = { qualified: vi.fn() };
  const scoring = new LeadScoringService(prisma as any, {} as any, insights as any, engine as any);
  return { scoring, prisma, engine };
}

describe('LeadScoringService and who the call reached', () => {
  it('a voicemail over 30s: the analysis is kept on the call, the lead is not rescored or moved', async () => {
    const { scoring, prisma, engine } = setup(extraction({ reached_person: false, high_engagement: false, summary: 'Voicemail greeting.' }));
    await scoring.classifyCall(ORG, 'call-1');
    expect(prisma.call.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'call-1' }, data: expect.objectContaining({ extractedIntel: expect.objectContaining({ qualification: expect.any(Object) }) }) }));
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('a person reached: scored and moved as before', async () => {
    const { scoring, prisma, engine } = setup(extraction({}));
    await scoring.classifyCall(ORG, 'call-1');
    expect(prisma.lead.update).toHaveBeenCalled();
    expect(engine.qualified).toHaveBeenCalledWith(ORG, LEAD, expect.any(String), expect.any(String), { callbackRequested: false });
  });

  it('an older analysis without the field still scores as before', async () => {
    const { reached_person: _omit, ...old } = extraction({});
    const { scoring, engine } = setup(old as Extraction);
    await scoring.classifyCall(ORG, 'call-1');
    expect(engine.qualified).toHaveBeenCalled();
  });
});

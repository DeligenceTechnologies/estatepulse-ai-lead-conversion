import { describe, expect, it, vi } from 'vitest';
import type { Extraction } from './lead-scoring';
import { LeadScoringService } from './lead-scoring.service';

const CALL = {
  id: 'call-1',
  orgId: 'org-1',
  leadId: 'lead-1',
  transcript: 'Assistant: Hi, is this Ana?',
  disposition: 'connected',
  extractedIntel: null,
  handoffRequested: false,
  createdAt: new Date('2026-10-27T10:00:00Z'),
};

const extraction = (over: Partial<Extraction>): Extraction => ({
  reached_person: true,
  do_not_contact: false,
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
  summary: 'A short call.',
  ...over,
});

function setup(x: Extraction, lead = { status: 'contacting', dncStatus: false }) {
  const prisma = {
    call: { findFirst: vi.fn(async () => CALL), update: vi.fn(async () => ({})) },
    organizationSetting: { findUnique: vi.fn(async () => null) },
    lead: { findFirst: vi.fn(async () => lead), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    leadEvent: { findFirst: vi.fn(async () => ({ fromStatus: 'contacting' })) },
    message: { findFirst: vi.fn(async () => null) },
  };
  const insights = { extractFromTranscript: vi.fn(async () => x) };
  const engine = { qualified: vi.fn(), setStatus: vi.fn() };
  const state = { move: vi.fn(async () => ({ moved: true, from: 'engaged' })) };
  const outcomes = { record: vi.fn(async () => ({ ok: true })) };
  const service = new LeadScoringService(prisma as any, {} as any, insights as any, engine as any, state as any, outcomes as any);
  return { service, prisma, engine, state, outcomes, run: () => service.classifyCall('org-1', 'call-1') };
}

describe('the call analysis', () => {
  it('a call that reached no one counts as not answered, and the lead goes back to where it was', async () => {
    const s = setup(extraction({ reached_person: false, summary: 'Voicemail greeting only.' }));
    await s.run();
    expect(s.prisma.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ disposition: 'voicemail' }) }));
    expect(s.state.move).toHaveBeenCalledWith('lead-1', 'contacting', expect.objectContaining({ onlyFrom: ['engaged'], alsoFrom: ['engaged'] }));
    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: 'lead-1', firstResponseAt: { gte: CALL.createdAt } }, data: { firstResponseAt: null } });
    expect(s.engine.qualified).not.toHaveBeenCalled();
    expect(s.engine.setStatus).not.toHaveBeenCalled();
  });

  it('a request not to be contacted is honoured even when the AI did not record it on the call', async () => {
    const s = setup(extraction({ do_not_contact: true, not_interested: true }));
    await s.run();
    expect(s.outcomes.record).toHaveBeenCalledWith({ orgId: 'org-1', leadId: 'lead-1', callId: 'call-1' }, expect.objectContaining({ outcome: 'do_not_contact' }));
    expect(s.engine.qualified).not.toHaveBeenCalled();
  });

  it('…once: a lead already do-not-contact is not opted out again', async () => {
    const s = setup(extraction({ do_not_contact: true }), { status: 'not_interested', dncStatus: true });
    await s.run();
    expect(s.outcomes.record).not.toHaveBeenCalled();
  });

  it('an analysis from before these were asked scores the call as before', async () => {
    const s = setup(extraction({ reached_person: undefined, do_not_contact: undefined, timeline: 'within_30_days' }));
    await s.run();
    expect(s.state.move).not.toHaveBeenCalled();
    expect(s.engine.qualified).toHaveBeenCalled();
  });
});

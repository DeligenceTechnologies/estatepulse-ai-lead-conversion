import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POINTS, scoringInstructions, type Criterion, type Extraction } from './lead-scoring';
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

function setup(x: Extraction, lead = { status: 'contacting', dncStatus: false }, settings: Record<string, unknown> | null = null) {
  const prisma = {
    call: { findFirst: vi.fn(async () => CALL), update: vi.fn(async () => ({})) },
    organizationSetting: { findUnique: vi.fn(async () => settings), upsert: vi.fn(async (args: { update: Record<string, unknown> }) => args.update) },
    lead: { findFirst: vi.fn(async () => lead), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    leadEvent: { findFirst: vi.fn(async () => ({ fromStatus: 'contacting' })) },
    message: { findFirst: vi.fn(async () => null) },
  };
  const insights = { extractFromTranscript: vi.fn(async () => x) };
  const engine = { qualified: vi.fn(), setStatus: vi.fn() };
  const state = { move: vi.fn(async () => ({ moved: true, from: 'engaged' })) };
  const outcomes = { record: vi.fn(async () => ({ ok: true })) };
  const memory = { afterCall: vi.fn(async () => undefined) };
  const service = new LeadScoringService(prisma as any, {} as any, insights as any, engine as any, state as any, outcomes as any, memory as any);
  return { service, prisma, engine, state, outcomes, memory, run: () => service.classifyCall('org-1', 'call-1') };
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

  it('a call that reached the lead updates the lead memory with what was said', async () => {
    const x = extraction({ answers: { family: 5 } });
    const s = setup(x);
    await s.run();
    expect(s.memory.afterCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'call-1' }), x);
  });

  it('a call that reached no one leaves the lead memory alone', async () => {
    const s = setup(extraction({ reached_person: false }));
    await s.run();
    expect(s.memory.afterCall).not.toHaveBeenCalled();
  });
});

/** The chart with one built-in line re-pointed. */
const at = (key: string, points: number) => (c: Criterion) => (c.key === key ? { ...c, points } : c);

const qualification = (s: ReturnType<typeof setup>, expected: Record<string, unknown>) =>
  expect(s.prisma.call.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ extractedIntel: expect.objectContaining({ qualification: expect.objectContaining(expected) }) }) }),
  );

describe('the assistant’s own score', () => {
  it('is used, with its temperature and reasons, when the analysis carries one', async () => {
    const s = setup(extraction({ lead_score: 82, lead_temperature: 'hot', score_reasons: 'Buying within 30 days +25; Budget identified +10' }));
    await s.run();
    qualification(s, {
      scoredBy: 'assistant',
      score: 82,
      temperature: 'hot',
      override: null,
      reasons: [
        { label: 'Buying within 30 days +25', points: 0 },
        { label: 'Budget identified +10', points: 0 },
      ],
    });
    expect(s.prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ score: 82 }) }));
    expect(s.engine.qualified).toHaveBeenCalledWith('org-1', 'lead-1', 'hot', expect.stringContaining('HOT — 82'), expect.anything());
  });

  it('still routes a caller who asked for a person as hot', async () => {
    const s = setup(extraction({ lead_score: 20, lead_temperature: 'cold', human_requested: true }));
    await s.run();
    expect(s.engine.qualified).toHaveBeenCalledWith('org-1', 'lead-1', 'hot', expect.stringContaining('Asked to speak with a person'), expect.anything());
  });

  it('keeps a rating that crosses the office’s lines, and says so', async () => {
    const s = setup(extraction({ lead_score: 80, lead_temperature: 'warm' }));
    await s.run();
    expect(s.engine.qualified).toHaveBeenCalledWith('org-1', 'lead-1', 'warm', expect.stringContaining('reads hot by your thresholds'), expect.anything());
  });

  it('…and the rules score an analysis that has none', async () => {
    const s = setup(extraction({ timeline: 'within_30_days', appointment_requested: true }));
    await s.run();
    qualification(s, { scoredBy: 'rules', score: 45, temperature: 'warm' });
  });

  it('the analysis is told the office’s points and thresholds, its own lines included', () => {
    const points = DEFAULT_POINTS.map(at('budget_identified', 12)).map(at('over_6_months', -5)).concat({ label: 'Has a home to sell', points: 15 });
    const text = scoringInstructions({ thresholds: { hot: 70, warm: 40 }, points });
    expect(text).toContain('hot at 70 or above, warm at 40 or above');
    expect(text).toContain('Budget identified +12');
    expect(text).toContain('Buying in over 6 months -5');
    expect(text).toContain('Has a home to sell +15');
  });
});

describe('the office’s own points chart', () => {
  const chart: Criterion[] = DEFAULT_POINTS.map(at('within_30_days', 40)).map(at('appointment_requested', 40));
  const saved = (points: unknown) => ({ leadHotThreshold: 75, leadWarmThreshold: 45, leadScorePoints: points });

  it('scores the rules fallback', async () => {
    const s = setup(extraction({ timeline: 'within_30_days', appointment_requested: true }), undefined, saved(chart));
    await s.run();
    qualification(s, { scoredBy: 'rules', score: 80, temperature: 'hot', reasons: [{ label: 'Buying within 30 days', points: 40 }, { label: 'Appointment requested', points: 40 }] });
  });

  it('…by its built-in lines only: a line the office took out counts nothing, a line it added is the assistant’s alone', async () => {
    const own = chart.filter((c) => c.key !== 'appointment_requested').concat({ label: 'Has a home to sell', points: 15 });
    const s = setup(extraction({ timeline: 'within_30_days', appointment_requested: true }), undefined, saved(own));
    await s.run();
    qualification(s, { scoredBy: 'rules', score: 40, temperature: 'cold' });
  });

  it('is the built-in chart until the office sets one, and when what is saved is not a chart', async () => {
    const s = setup(extraction({ timeline: 'within_30_days' }), undefined, saved({ within_30_days: 40 }));
    await s.run();
    qualification(s, { scoredBy: 'rules', score: 25 });
  });

  it('is saved with the thresholds, and refused when a line breaks the rule', async () => {
    const s = setup(extraction({}));
    await s.service.setSettings('org-1', { hotThreshold: 70, warmThreshold: 40, points: chart });
    expect(s.prisma.organizationSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { leadHotThreshold: 70, leadWarmThreshold: 40, leadScorePoints: chart } }));
    const refused = (points: unknown) => expect(s.service.setSettings('org-1', { hotThreshold: 70, warmThreshold: 40, points })).rejects.toThrow('whole number');
    await refused(chart.map(at('budget_identified', 150)));
    await refused(chart.concat({ label: ' ', points: 5 }));
    await refused(chart.concat({ label: 'x'.repeat(81), points: 5 }));
    await refused(chart.concat({ key: 'budget_identified', label: 'Budget again', points: 5 }));
    await refused(chart.concat(Array.from({ length: 10 }, (_, i) => ({ label: `Line ${i}`, points: 1 }))));
    await refused([]);
    await s.service.setSettings('org-1', { hotThreshold: 70, warmThreshold: 40 });
    expect(s.prisma.organizationSetting.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { leadHotThreshold: 70, leadWarmThreshold: 40 } }));
  });
});

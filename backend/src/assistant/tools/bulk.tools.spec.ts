import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { MAX_BULK, bulkCard, selectLeads, skippedLine } from './bulk';
import { bulkTools } from './bulk.tools';
import { fakeRefs } from './fake-refs.test';

const ORG = 'org-1';
const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read', 'lead.update', 'lead.assign', 'automation.update', 'assistant.bulk'] };
const agent: AuthContext = { userId: 'agent-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };

const lead = (i: number, over: object = {}) => ({ id: `lead-${i}`, firstName: `Lead`, lastName: `${i}`, ...over });

function setup(rows: object[], opts: { total?: number; agentCap?: number | null; holds?: number; enrolled?: string[] } = {}) {
  const prisma = {
    lead: {
      count: vi.fn(async (args: any) => (args.where.assignedToId === 'agent-9' && args.where.status ? (opts.holds ?? 0) : (opts.total ?? rows.length))),
      findMany: vi.fn(async () => rows),
    },
    user: { findFirst: vi.fn(async () => ({ firstName: 'Priya', lastName: 'Shah', email: 'p@x.test', maxActiveLeads: opts.agentCap ?? null })) },
    sequenceEnrollment: { findMany: vi.fn(async () => (opts.enrolled ?? []).map((leadId) => ({ leadId }))) },
  };
  const deps = {
    prisma,
    assignments: { assign: vi.fn(async () => ({ changed: true, agent: { name: 'Priya Shah' } })) },
    engine: { setStatus: vi.fn(async () => true) },
    followup: {
      getSequence: vi.fn(async () => ({ id: 'seq-1', name: 'Nurture 30', status: 'active', steps: [{}, {}] })),
      enrollLeads: vi.fn(async () => ({ enrolled: 1, skipped: [] })),
    },
    control: { pause: vi.fn(async () => ({ paused: true })), resume: vi.fn(async () => ({ strategy: 'continued' })) },
  };
  const tools = Object.fromEntries(bulkTools(deps as never).map((t) => [t.name, t as any]));
  const refs = fakeRefs();
  return { prisma, deps, tools, refs };
}

describe('choosing the leads', () => {
  it('a filter keeps to the leads the user may see, out of import review', async () => {
    const s = setup([lead(1)]);
    await s.refs.issue('user', ['agent-9']);
    await selectLeads(s.prisma as any, agent, s.refs, { filter: { temperature: 'warm', assignedTo: 'U1', noContactSince: '2026-08-01T00:00:00Z' } }, { status: true });
    const where = (s.prisma.lead.findMany.mock.calls[0] as any[])[0].where;
    expect(where.AND[0]).toMatchObject({ orgId: ORG, mergedIntoId: null, assignedToId: 'agent-1' });
    expect(where.AND[1]).toMatchObject({ temperature: 'warm', assignedToId: 'agent-9', OR: [{ lastContactAt: null }, { lastContactAt: { lt: new Date('2026-08-01T00:00:00Z') } }] });
  });

  it('refs from the chat are checked like any ref; refs and a filter together are refused', async () => {
    const s = setup([lead(1)]);
    await expect(selectLeads(s.prisma as any, owner, s.refs, { leads: ['L7'] }, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(selectLeads(s.prisma as any, owner, s.refs, { leads: ['L1'], filter: {} }, {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it(`more than ${MAX_BULK} matches asks for a narrower filter`, async () => {
    const s = setup([], { total: 640 });
    await expect(selectLeads(s.prisma as any, owner, s.refs, { filter: {} }, {})).rejects.toMatchObject({ code: 'BULK_LIMIT' });
  });
});

describe('the bulk card', () => {
  it('shows the count, five names and what was left out', () => {
    const card = bulkCard({ title: (n) => `Assign ${n} leads`, leads: Array.from({ length: 12 }, (_, i) => lead(i + 1)), skipped: { 'already with Priya Shah': 3, 'opted out': 1 } });
    expect(card.title).toBe('Assign 12 leads');
    expect(card.changes).toEqual([{ field: 'Leads', from: null, to: '12' }]);
    expect(card.summary).toBe(
      'Includes Lead 1, Lead 2, Lead 3, Lead 4, Lead 5 and 7 more. Left out: 3 already with Priya Shah, 1 opted out. It runs in the background; the card shows progress and can stop it.',
    );
    expect(card.bulk!.leadIds).toHaveLength(12);
  });

  it('refuses a card where every lead was left out, saying why', () => {
    expect(() => bulkCard({ title: () => 'x', leads: [], skipped: { 'already paused': 4 } })).toThrow('None of these leads can be changed: 4 already paused.');
    expect(skippedLine({ a: 1, b: 5 })).toBe('5 b, 1 a');
  });
});

describe('bulk tools', () => {
  it('leads_assign leaves out leads the agent holds and warns about the cap', async () => {
    const s = setup([lead(1, { assignedToId: 'agent-9' }), lead(2, { assignedToId: null }), lead(3, { assignedToId: null })], { agentCap: 30, holds: 29 });
    await s.refs.issue('user', ['agent-9']);
    const card = await s.tools.leads_assign.preview({ auth: owner, refs: s.refs }, { filter: { location: 'Austin' }, agent: 'U1' });
    expect(card.bulk.leadIds).toEqual(['lead-2', 'lead-3']);
    expect(card.summary).toContain('Left out: 1 already with Priya Shah.');
    expect(card.summary).toContain('Priya Shah has room for 1 more (cap 30)');
    await s.tools.leads_assign.bulk.runOne({ auth: owner, refs: s.refs }, { filter: {}, agent: 'U1' }, 'lead-2');
    expect(s.deps.assignments.assign).toHaveBeenCalledWith(ORG, 'lead-2', 'agent-9', expect.objectContaining({ actorType: 'ai', actorId: 'owner-1' }));
  });

  it('leads_set_status leaves out leads already there, and records the person', async () => {
    const s = setup([lead(1, { status: 'closed' }), lead(2, { status: 'contacting' })]);
    const card = await s.tools.leads_set_status.preview({ auth: owner, refs: s.refs }, { filter: {}, status: 'closed' });
    expect(card.title).toBe('Move 1 lead to Closed');
    await s.tools.leads_set_status.bulk.runOne({ auth: owner, refs: s.refs }, { filter: {}, status: 'closed', reason: 'Old' }, 'lead-2');
    expect(s.deps.engine.setStatus).toHaveBeenCalledWith(ORG, 'lead-2', 'closed', 'Old', expect.objectContaining({ actor: { type: 'user', id: 'owner-1' }, source: 'assistant' }));
  });

  it('leads_sequence_enroll leaves out opted-out, enrolled, paused and in-strategy leads', async () => {
    const s = setup([
      lead(1, { dncStatus: true, automationPaused: false, status: 'follow_up', firstContactAt: null }),
      lead(2, { dncStatus: false, automationPaused: false, status: 'follow_up', firstContactAt: null }),
      lead(3, { dncStatus: false, automationPaused: true, status: 'follow_up', firstContactAt: null }),
      lead(4, { dncStatus: false, automationPaused: false, status: 'contacting', firstContactAt: new Date() }),
      lead(5, { dncStatus: false, automationPaused: false, status: 'unresponsive', firstContactAt: new Date() }),
    ], { enrolled: ['lead-2'] });
    await s.refs.issue('sequence', ['seq-1']);
    const card = await s.tools.leads_sequence_enroll.preview({ auth: owner, refs: s.refs }, { filter: {}, sequence: 'S1' });
    expect(card.bulk.leadIds).toEqual(['lead-5']);
    expect(card.summary).toContain('1 opted out, 1 already in a sequence, 1 with outreach paused, 1 still in the outreach strategy');
  });

  it('leads_outreach_pause and resume leave out leads already in that state, and run through the pause service', async () => {
    const s = setup([lead(1, { automationPaused: true, dncStatus: false }), lead(2, { automationPaused: false, dncStatus: false })]);
    expect((await s.tools.leads_outreach_pause.preview({ auth: owner, refs: s.refs }, { filter: {} })).bulk.leadIds).toEqual(['lead-2']);
    await s.tools.leads_outreach_pause.bulk.runOne({ auth: owner, refs: s.refs }, { filter: {}, reason: 'Holiday' }, 'lead-2');
    expect(s.deps.control.pause).toHaveBeenCalledWith(owner, 'lead-2', { source: 'assistant', reason: 'Holiday' });
    const r = setup([lead(1, { automationPaused: true, dncStatus: false, consentStatus: 'granted', needsReview: false, reviewReasons: [] }), lead(2, { automationPaused: false })]);
    expect((await r.tools.leads_outreach_resume.preview({ auth: owner, refs: r.refs }, { filter: {} })).bulk.leadIds).toEqual(['lead-1']);
  });

  it('a bulk tool never runs inline', async () => {
    const s = setup([lead(1)]);
    await expect(s.tools.leads_outreach_pause.run({ auth: owner, refs: s.refs }, { filter: {} })).rejects.toThrow(/background job/);
  });
});

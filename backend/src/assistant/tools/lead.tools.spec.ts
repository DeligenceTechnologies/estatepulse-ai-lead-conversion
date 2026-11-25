import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { leadTools } from './lead.tools';

const ORG = 'org-1';
const LEAD = '0197a1b2-0000-7000-8000-000000000001';
const AGENT = '0197a1b2-0000-7000-8000-0000000000a1';
const UPDATED = new Date('2026-11-25T10:00:00Z');

const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read', 'lead.update', 'lead.assign', 'lead.import'] };
/** An agent without lead.read sees only the leads assigned to them. */
const agent: AuthContext = { userId: AGENT, organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };

const leadRow = {
  id: LEAD,
  firstName: 'Maria',
  lastName: 'Lopez',
  phone: '+15125550101',
  email: 'maria@example.com',
  status: 'interested',
  temperature: 'hot',
  score: 92,
  location: 'Austin, TX',
  createdAt: UPDATED,
  updatedAt: UPDATED,
  leadSource: { name: 'Website' },
  assignedTo: null,
  motivation: null,
  timeline: null,
  minBudget: null,
  maxBudget: null,
  bedrooms: null,
  financingStatus: null,
  needsReview: false,
  reviewReasons: [],
};

function setup(opts: { lead?: typeof leadRow | null; agentInOrg?: boolean } = {}) {
  const prisma = {
    lead: {
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => [leadRow]),
      findFirst: vi.fn(async () => (opts.lead === undefined ? leadRow : opts.lead)),
      groupBy: vi.fn(async () => []),
    },
    user: {
      findFirst: vi.fn(async () => (opts.agentInOrg === false ? null : { firstName: 'Priya', lastName: 'Shah', email: 'priya@x.test' })),
      findMany: vi.fn(async () => []),
    },
  };
  const deps = { prisma, edits: {}, assignments: {}, manualLeads: {}, reviews: {} };
  const tools = Object.fromEntries(leadTools(deps as any).map((t) => [t.name, t as any]));
  return { prisma, tools };
}

/** The first part of every lead query: who may see what. */
const scopeOf = (call: unknown[]) => (call[0] as { where: { AND: Record<string, unknown>[] } }).where.AND[0];

describe('lead tools: who sees what', () => {
  it('an agent searches only their own leads, in their own office, never merged-away ones', async () => {
    const s = setup();
    await s.tools.lead_search.run({ auth: agent }, { temperature: 'hot', limit: 10 });
    const scope = scopeOf(s.prisma.lead.findMany.mock.calls[0]);
    expect(scope).toMatchObject({ orgId: ORG, mergedIntoId: null, assignedToId: AGENT });
    // Leads still in import review stay out too.
    expect(scope).toHaveProperty('sheetImportRows');
  });

  it('an owner with lead.read searches every lead of the office, and only that office', async () => {
    const s = setup();
    await s.tools.lead_search.run({ auth: owner }, { limit: 10 });
    const scope = scopeOf(s.prisma.lead.findMany.mock.calls[0]);
    expect(scope).toMatchObject({ orgId: ORG, mergedIntoId: null });
    expect(scope).not.toHaveProperty('assignedToId');
  });

  it('counts for lead_stats use the same scope as search', async () => {
    const s = setup();
    await s.tools.lead_stats.run({ auth: agent }, {});
    for (const call of s.prisma.lead.count.mock.calls) {
      expect(scopeOf(call)).toMatchObject({ orgId: ORG, assignedToId: AGENT });
    }
  });

  it('opening a lead the user cannot see answers NOT_FOUND, the same as one that does not exist', async () => {
    const s = setup({ lead: null });
    await expect(s.tools.lead_get.run({ auth: agent }, { leadId: LEAD })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(scopeOf(s.prisma.lead.findFirst.mock.calls[0])).toMatchObject({ orgId: ORG, assignedToId: AGENT });
  });

  it('assigning to someone outside the office is refused at the card', async () => {
    const s = setup({ agentInOrg: false });
    await expect(s.tools.lead_assign.preview({ auth: owner }, { leadId: LEAD, agentId: AGENT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: AGENT, orgId: ORG } }));
  });

  it('team_list needs lead.read, like the team screen', () => {
    const s = setup();
    expect(s.tools.team_list.permissions).toEqual(['lead.read']);
  });
});

describe('lead tools: cards', () => {
  it('a lead update card shows each change from and to, tied to the version it was built on', async () => {
    const s = setup();
    const preview = await s.tools.lead_update.preview({ auth: owner }, { leadId: LEAD, firstName: 'Mariah', location: 'Austin, TX' });
    expect(preview.changes).toEqual([{ field: 'First name', from: 'Maria', to: 'Mariah' }]);
    expect(preview.entity).toEqual({ type: 'lead', id: LEAD, version: UPDATED });
  });

  it('an update that changes nothing is refused instead of shown', async () => {
    const s = setup();
    await expect(s.tools.lead_update.preview({ auth: owner }, { leadId: LEAD, firstName: 'Maria' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('a new lead needs a phone or an email', async () => {
    const s = setup();
    await expect(
      s.tools.lead_create.preview({ auth: owner }, { firstName: 'Ana', consent: false, startOutreach: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('the update tool refuses fields it does not own, such as status or organization', () => {
    const s = setup();
    const parsed = s.tools.lead_update.input.safeParse({ leadId: LEAD, status: 'won' });
    expect(parsed.success).toBe(false);
  });
});

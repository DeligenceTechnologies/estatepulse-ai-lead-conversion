import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { leadTools } from './lead.tools';
import { REF_LETTER, type RefKind, type RefTable } from './refs';

const ORG = 'org-1';
const LEAD = '0197a1b2-0000-7000-8000-000000000001';
const AGENT = '0197a1b2-0000-7000-8000-0000000000a1';
const UPDATED = new Date();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

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
  lastContactAt: null,
  createdAt: UPDATED,
  updatedAt: UPDATED,
  leadSource: { name: 'Website' },
  assignedTo: { id: AGENT, firstName: 'Priya', lastName: 'Shah' },
  motivation: null,
  timeline: null,
  minBudget: null,
  maxBudget: null,
  bedrooms: null,
  financingStatus: null,
  needsReview: false,
  reviewReasons: [],
};

/** A chat's refs kept in memory: numbered per kind in the order issued; anything else is NOT_FOUND. */
function fakeRefs(): RefTable & { refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const ids = new Map<string, string>();
  const counts: Record<string, number> = {};
  return {
    refs,
    issue: vi.fn(async (kind: RefKind, list: readonly string[]) => {
      const out = new Map<string, string>();
      for (const id of list) {
        let ref = refs.get(`${kind}:${id}`);
        if (!ref) {
          ref = `${REF_LETTER[kind]}${(counts[kind] = (counts[kind] ?? 0) + 1)}`;
          refs.set(`${kind}:${id}`, ref);
          ids.set(ref, id);
        }
        out.set(id, ref);
      }
      return out;
    }),
    resolve: vi.fn(async (_kind: RefKind, ref: string) => {
      const id = ids.get(ref);
      if (!id) throw new AppError('NOT_FOUND', `${ref} is not from this chat.`);
      return id;
    }),
  };
}

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
      findMany: vi.fn(async () => [{ id: AGENT, firstName: 'Priya', lastName: 'Shah', email: 'priya@x.test', maxActiveLeads: 50 }]),
    },
  };
  const manualLeads = { create: vi.fn(async () => ({ id: LEAD, matchedBy: null })) };
  const edits = { update: vi.fn(async () => ({ changed: { firstName: 'Mariah' }, becameDoNotContact: false })) };
  const deps = { prisma, edits, assignments: {}, manualLeads, reviews: {} };
  const tools = Object.fromEntries(leadTools(deps as any).map((t) => [t.name, t as any]));
  const refs = fakeRefs();
  /** A lead ref as an earlier result in the chat would have issued it. */
  const leadRefIssued = async () => (await refs.issue('lead', [LEAD])).get(LEAD)!;
  return { prisma, tools, refs, edits, manualLeads, leadRefIssued };
}

/** The first part of every lead query: who may see what. */
const scopeOf = (call: unknown[]) => (call[0] as { where: { AND: Record<string, unknown>[] } }).where.AND[0];

describe('lead tools: who sees what', () => {
  it('an agent searches only their own leads, in their own office, never merged-away ones', async () => {
    const s = setup();
    await s.tools.lead_search.run({ auth: agent, refs: s.refs }, { temperature: 'hot', limit: 10 });
    const scope = scopeOf(s.prisma.lead.findMany.mock.calls[0]);
    expect(scope).toMatchObject({ orgId: ORG, mergedIntoId: null, assignedToId: AGENT });
    // Leads still in import review stay out too.
    expect(scope).toHaveProperty('sheetImportRows');
  });

  it('an owner with lead.read searches every lead of the office, and only that office', async () => {
    const s = setup();
    await s.tools.lead_search.run({ auth: owner, refs: s.refs }, { limit: 10 });
    const scope = scopeOf(s.prisma.lead.findMany.mock.calls[0]);
    expect(scope).toMatchObject({ orgId: ORG, mergedIntoId: null });
    expect(scope).not.toHaveProperty('assignedToId');
  });

  it('a name search scores only leads inside the same scope', async () => {
    const s = setup();
    await s.tools.lead_search.run({ auth: agent, refs: s.refs }, { query: 'Maria', limit: 10 });
    const candidates = s.prisma.lead.findMany.mock.calls[0] as any[];
    expect(candidates[0].where.AND[0].AND[0]).toMatchObject({ orgId: ORG, assignedToId: AGENT });
  });

  it('counts for lead_stats use the same scope as search', async () => {
    const s = setup();
    await s.tools.lead_stats.run({ auth: agent, refs: s.refs }, {});
    for (const call of s.prisma.lead.count.mock.calls) {
      expect(scopeOf(call)).toMatchObject({ orgId: ORG, assignedToId: AGENT });
    }
  });

  it('a ref this chat never issued answers NOT_FOUND without touching leads', async () => {
    const s = setup();
    await expect(s.tools.lead_get.run({ auth: agent, refs: s.refs }, { lead: 'L7' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.prisma.lead.findFirst).not.toHaveBeenCalled();
  });

  it('a lead still in review is refused, and the look-up keeps the user scope', async () => {
    const s = setup({ lead: null });
    const ref = await s.leadRefIssued();
    await expect(s.tools.lead_get.run({ auth: agent, refs: s.refs }, { lead: ref })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(scopeOf(s.prisma.lead.findFirst.mock.calls[0])).toMatchObject({ orgId: ORG, assignedToId: AGENT });
  });

  it('assigning to someone outside the office is refused at the card', async () => {
    const s = setup({ agentInOrg: false });
    const lead = await s.leadRefIssued();
    const [agentRef] = (await s.refs.issue('user', [AGENT])).values();
    await expect(s.tools.lead_assign.preview({ auth: owner, refs: s.refs }, { lead, agent: agentRef })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: AGENT, orgId: ORG } }));
  });

  it('team_list needs lead.read, like the team screen', () => {
    const s = setup();
    expect(s.tools.team_list.permissions).toEqual(['lead.read']);
  });
});

describe('lead tools: refs, never ids', () => {
  it('every tool that names a lead, agent or call refuses a raw id', () => {
    const s = setup();
    expect(s.tools.lead_get.input.safeParse({ lead: LEAD }).success).toBe(false);
    expect(s.tools.lead_update.input.safeParse({ lead: LEAD, firstName: 'Ana' }).success).toBe(false);
    expect(s.tools.lead_assign.input.safeParse({ lead: 'L1', agent: AGENT }).success).toBe(false);
    expect(s.tools.lead_assign.input.safeParse({ lead: 'U1', agent: 'L1' }).success).toBe(false);
    expect(s.tools.lead_review_approve.input.safeParse({ lead: 'L1' }).success).toBe(true);
    expect(s.tools.lead_search.input.safeParse({ assignedTo: AGENT }).success).toBe(false);
  });

  it('search results show refs for the lead and its agent, and no ids anywhere', async () => {
    const s = setup();
    const result = await s.tools.lead_search.run({ auth: owner, refs: s.refs }, { limit: 10 });
    expect(result.leads[0]).toMatchObject({ ref: 'L1', name: 'Maria Lopez', assignedTo: { ref: 'U1', name: 'Priya Shah' } });
    expect(JSON.stringify(result)).not.toMatch(UUID);
  });

  it('a lead keeps its ref however many times it is shown', async () => {
    const s = setup();
    await s.tools.lead_search.run({ auth: owner, refs: s.refs }, { limit: 10 });
    const opened = await s.tools.lead_get.run({ auth: owner, refs: s.refs }, { lead: 'L1' });
    expect(opened).toMatchObject({ ref: 'L1', name: 'Maria Lopez' });
    expect(JSON.stringify(opened)).not.toMatch(UUID);
  });

  it('team_list gives each agent a ref the assignment tool takes', async () => {
    const s = setup();
    const team = await s.tools.team_list.run({ auth: owner, refs: s.refs }, {});
    expect(team).toEqual([expect.objectContaining({ ref: 'U1', name: 'Priya Shah' })]);
    expect(JSON.stringify(team)).not.toMatch(UUID);
  });

  it("filtering by an agent's ref searches that agent's leads", async () => {
    const s = setup();
    await s.refs.issue('user', [AGENT]);
    await s.tools.lead_search.run({ auth: owner, refs: s.refs }, { assignedTo: 'U1', limit: 10 });
    expect((s.prisma.lead.findMany.mock.calls[0] as any[])[0].where.AND[1]).toMatchObject({ assignedToId: AGENT });
  });

  it('an update runs on the lead behind the ref', async () => {
    const s = setup();
    const lead = await s.leadRefIssued();
    await s.tools.lead_update.run({ auth: owner, refs: s.refs }, { lead, firstName: 'Mariah' });
    expect(s.edits.update).toHaveBeenCalledWith(owner, LEAD, { firstName: 'Mariah' });
  });

  it('a new lead comes back as a ref', async () => {
    const s = setup();
    const result = await s.tools.lead_create.run({ auth: owner, refs: s.refs }, { firstName: 'Ana', phone: '+15125550199', consent: false, startOutreach: false });
    expect(result).toEqual({ ref: 'L1' });
  });
});

describe('lead tools: search by name', () => {
  it('one clear match says so', async () => {
    const s = setup();
    const result = await s.tools.lead_search.run({ auth: owner, refs: s.refs }, { query: 'maria lopez', limit: 10 });
    expect(result).toMatchObject({ match: 'one', total: 1, leads: [{ ref: 'L1', name: 'Maria Lopez' }] });
    expect(result).not.toHaveProperty('note');
  });

  it('nothing close says none, with no leads offered as the one meant', async () => {
    const s = setup();
    const result = await s.tools.lead_search.run({ auth: owner, refs: s.refs }, { query: 'Zebulon', limit: 10 });
    expect(result).toMatchObject({ match: 'none', total: 0, leads: [] });
  });
});

describe('lead tools: cards', () => {
  it('a lead update card shows each change from and to, tied to the version it was built on', async () => {
    const s = setup();
    const lead = await s.leadRefIssued();
    const preview = await s.tools.lead_update.preview({ auth: owner, refs: s.refs }, { lead, firstName: 'Mariah', location: 'Austin, TX' });
    expect(preview.changes).toEqual([{ field: 'First name', from: 'Maria', to: 'Mariah' }]);
    expect(preview.entity).toEqual({ type: 'lead', id: LEAD, version: UPDATED });
  });

  it('an update that changes nothing is refused instead of shown', async () => {
    const s = setup();
    const lead = await s.leadRefIssued();
    await expect(s.tools.lead_update.preview({ auth: owner, refs: s.refs }, { lead, firstName: 'Maria' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('a new lead needs a phone or an email', async () => {
    const s = setup();
    await expect(
      s.tools.lead_create.preview({ auth: owner, refs: s.refs }, { firstName: 'Ana', consent: false, startOutreach: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('the update tool refuses fields it does not own, such as status or organization', () => {
    const s = setup();
    const parsed = s.tools.lead_update.input.safeParse({ lead: 'L1', status: 'won' });
    expect(parsed.success).toBe(false);
  });
});

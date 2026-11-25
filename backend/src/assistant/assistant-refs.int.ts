import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TenantContext } from '@/common/prisma/tenant-context';
import { CONSENT_REVIEW_REASON } from '@/lead/consent';
import { AssistantRefService } from './assistant-ref.service';
import { historyTools } from './tools/history.tools';
import { leadTools } from './tools/lead.tools';
import type { RefTable } from './tools/refs';

/**
 * Refs and lead search against the real database (backend/.env), with the real tenant guard:
 * the unique keys, skipDuplicates under a race, the cascade, and the search queries Prisma builds.
 * Run: npx vitest run -c vitest.integration.config.ts src/assistant/assistant-refs.int.ts
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const guarded = prisma.withTenancyGuard();
const refService = new AssistantRefService(guarded, prisma);
const tools = Object.fromEntries(
  [...leadTools({ prisma, edits: {}, assignments: {}, manualLeads: {}, reviews: {} } as never), ...historyTools({} as never, prisma)].map((t) => [t.name, t as any]),
);

const orgs: string[] = [];
let orgId: string;
let owner: AuthContext;
let agent: AuthContext;
const leads: Record<string, string> = {};

async function thread(who: AuthContext): Promise<string> {
  const t = await prisma.assistantThread.create({ data: { orgId: who.organizationId, userId: who.userId, title: 'int' } });
  return t.id;
}

const inOrg = <T>(fn: () => Promise<T>, org = orgId) => TenantContext.run(org, fn);
const search = (who: AuthContext, refs: RefTable, input: Record<string, unknown>) =>
  inOrg((): Promise<any> => tools.lead_search.run({ auth: who, refs }, { limit: 10, ...input }));

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `assistant-refs-int ${randomUUID().slice(0, 8)}` } });
  orgs.push(org.id);
  orgId = org.id;
  const user = (first: string) =>
    prisma.user.create({ data: { orgId, firstName: first, lastName: 'Test', email: `refs-${randomUUID()}@example.test`, password: 'not-a-real-hash' } });
  const [o, a] = await Promise.all([user('Owner'), user('Agent')]);
  owner = { userId: o.id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions: ['lead.read', 'lead.update', 'lead.assign'] };
  agent = { userId: a.id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions: ['lead.update'] };

  const lead = async (key: string, data: Record<string, unknown>) => {
    leads[key] = (await prisma.lead.create({ data: { orgId, ...data } })).id;
  };
  await lead('rahulSharma', { firstName: 'Rahul', lastName: 'Sharma', assignedToId: a.id, lastContactAt: new Date() });
  await lead('rahulVerma', { firstName: 'Rahul', lastName: 'Verma' });
  await lead('maria', { firstName: 'María', lastName: 'López', phone: '(512) 555-0101', normalizedPhone: '+15125550101', email: 'Maria@Example.test', normalizedEmail: 'maria@example.test' });
  await lead('priya', { firstName: 'Priya', lastName: 'Shah', location: 'Austin, TX' });
  // Merged into Rahul Sharma: kept for history, never found.
  await lead('rahulDuplicate', { firstName: 'Rahul', lastName: 'Sharma', mergedIntoId: leads.rahulSharma });
  // Still waiting for consent review: out of every list.
  await lead('rahulReview', { firstName: 'Rahul', lastName: 'Sinha', reviewReasons: [CONSENT_REVIEW_REASON] });
});

afterAll(async () => {
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.$disconnect();
});

describe('lead search on the real database', () => {
  it('a shared first name is ambiguous, leaving out merged-away leads and leads in review', async () => {
    const refs = refService.forThread(owner, await thread(owner));
    const result = await search(owner, refs, { query: 'rahul' });
    expect(result.match).toBe('ambiguous');
    expect(result.leads.map((l: { name: string }) => l.name).sort()).toEqual(['Rahul Sharma', 'Rahul Verma']);
    // Recently contacted, so first.
    expect(result.leads[0]).toMatchObject({ ref: 'L1', name: 'Rahul Sharma' });
  });

  it('the full name is one clear match, and keeps the ref it got before', async () => {
    const refs = refService.forThread(owner, await thread(owner));
    await search(owner, refs, { query: 'rahul' });
    const result = await search(owner, refs, { query: 'Rahul Verma' });
    expect(result).toMatchObject({ match: 'one', leads: [{ ref: 'L2', name: 'Rahul Verma' }] });
  });

  it('finds a name typed without its accents', async () => {
    const refs = refService.forThread(owner, await thread(owner));
    expect(await search(owner, refs, { query: 'maria lopez' })).toMatchObject({ match: 'one', leads: [{ name: 'María López' }] });
  });

  it('a phone number, typed any way, and an email find the same lead under the same ref', async () => {
    const refs = refService.forThread(owner, await thread(owner));
    const byPhone = await search(owner, refs, { query: '+1 512-555-0101' });
    const byLocal = await search(owner, refs, { query: '512 555 0101' });
    const byEmail = await search(owner, refs, { query: 'MARIA@example.test' });
    for (const r of [byPhone, byLocal, byEmail]) expect(r).toMatchObject({ match: 'one', leads: [{ ref: 'L1', name: 'María López' }] });
  });

  it('an agent finds only their own Rahul, so for them the name is clear', async () => {
    const refs = refService.forThread(agent, await thread(agent));
    expect(await search(agent, refs, { query: 'rahul' })).toMatchObject({ match: 'one', leads: [{ name: 'Rahul Sharma' }] });
  });

  it('filters still work without a query', async () => {
    const refs = refService.forThread(owner, await thread(owner));
    expect(await search(owner, refs, { location: 'austin' })).toMatchObject({ total: 1, leads: [{ name: 'Priya Shah' }] });
  });
});

describe('refs on the real database', () => {
  it('two requests issuing at once agree on every ref and never share a number', async () => {
    const id = await thread(owner);
    const [a, b] = await inOrg(() =>
      Promise.all([
        refService.forThread(owner, id).issue('lead', [leads.rahulSharma, leads.rahulVerma]),
        refService.forThread(owner, id).issue('lead', [leads.rahulVerma, leads.maria]),
      ]),
    );
    expect(a.get(leads.rahulVerma)).toBe(b.get(leads.rahulVerma));
    const rows = await prisma.assistantRef.findMany({ where: { threadId: id } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.number)).size).toBe(3);
  });

  it('a ref from one chat resolves to nothing in another', async () => {
    const first = await thread(owner);
    const second = await thread(owner);
    await inOrg(() => refService.forThread(owner, first).issue('lead', [leads.priya]));
    await expect(inOrg(() => refService.forThread(owner, second).resolve('lead', 'L1'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(inOrg(() => refService.forThread(owner, first).resolve('lead', 'L1'))).resolves.toBe(leads.priya);
  });

  it("an agent's ref to a lead they cannot see resolves to nothing", async () => {
    const id = await thread(agent);
    await inOrg(() => refService.forThread(agent, id).issue('lead', [leads.rahulSharma, leads.rahulVerma]));
    const refs = refService.forThread(agent, id);
    await expect(inOrg(() => refs.resolve('lead', 'L1'))).resolves.toBe(leads.rahulSharma);
    await expect(inOrg(() => refs.resolve('lead', 'L2'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("another office cannot read a chat's refs", async () => {
    const id = await thread(owner);
    await inOrg(() => refService.forThread(owner, id).issue('lead', [leads.priya]));
    const other = await prisma.organization.create({ data: { name: `assistant-refs-int other ${randomUUID().slice(0, 8)}` } });
    orgs.push(other.id);
    // A Prisma query runs when awaited, so it is awaited inside the other office's context.
    expect(await inOrg(async () => await guarded.assistantRef.findMany({ where: { threadId: id } }), other.id)).toEqual([]);
  });

  it('a slot ref keeps the start time it stands for, which is not a uuid', async () => {
    const id = await thread(owner);
    const start = '2026-11-27T21:00:00.000Z';
    const issued = await inOrg(() => refService.forThread(owner, id).issue('slot', [start]));
    expect(issued.get(start)).toBe('T1');
    await expect(inOrg(() => refService.forThread(owner, id).resolve('slot', 'T1'))).resolves.toBe(start);
  });

  it("a sequence ref resolves only to the office's own sequence", async () => {
    const id = await thread(owner);
    const seq = await prisma.sequence.create({ data: { orgId, code: `int-${randomUUID().slice(0, 8)}`, name: 'Nurture' } });
    const other = await prisma.organization.create({ data: { name: `assistant-refs-int seq ${randomUUID().slice(0, 8)}` } });
    orgs.push(other.id);
    const theirs = await prisma.sequence.create({ data: { orgId: other.id, code: 'theirs', name: 'Theirs' } });
    await inOrg(() => refService.forThread(owner, id).issue('sequence', [seq.id, theirs.id]));
    await expect(inOrg(() => refService.forThread(owner, id).resolve('sequence', 'S1'))).resolves.toBe(seq.id);
    await expect(inOrg(() => refService.forThread(owner, id).resolve('sequence', 'S2'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("the timeline shows a lead's events newest first, with people as refs", async () => {
    const refs = refService.forThread(owner, await thread(owner));
    const base = { orgId, leadId: leads.priya };
    await prisma.leadEvent.create({ data: { ...base, type: 'status_changed', fromStatus: 'new', toStatus: 'contacting', source: 'strategy', actorType: 'system', createdAt: new Date(Date.now() - 60_000) } });
    await prisma.leadEvent.create({ data: { ...base, type: 'outreach_stopped', source: 'assistant', actorType: 'user', actorId: owner.userId, reason: 'Working with another agent' } });
    await search(owner, refs, { query: 'Priya Shah' });
    const timeline = await inOrg((): Promise<any> => tools.lead_timeline.run({ auth: owner, refs }, { lead: 'L1', limit: 10 }));
    expect(timeline.map((e: { event: string }) => e.event)).toEqual(['outreach_stopped', 'status_changed']);
    expect(timeline[0]).toMatchObject({ by: 'U1', reason: 'Working with another agent', source: 'assistant' });
    expect(timeline[1]).toMatchObject({ by: 'system', status: { from: 'new', to: 'contacting' } });
  });

  it('deleting the chat deletes its refs', async () => {
    const id = await thread(owner);
    await inOrg(() => refService.forThread(owner, id).issue('lead', [leads.priya]));
    await prisma.assistantThread.delete({ where: { id } });
    expect(await prisma.assistantRef.count({ where: { threadId: id } })).toBe(0);
  });
});

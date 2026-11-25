import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AssistantRefService } from './assistant-ref.service';

const ORG = 'org-1';
const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read'] };
const agent: AuthContext = { userId: 'agent-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: [] };

interface RefRow {
  orgId: string;
  threadId: string;
  entityType: string;
  entityId: string;
  number: number;
}

/** assistant_refs in memory, with both unique keys enforced the way createMany's skipDuplicates does. */
function fakeDb() {
  const rows: RefRow[] = [];
  const matches = (r: RefRow, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes((r as any)[k]) : (r as any)[k] === v));
  const db = {
    rows,
    /** Rows another request writes between our read and our insert, to force a clash. */
    sneakIn: [] as RefRow[],
    assistantRef: {
      findFirst: vi.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
      aggregate: vi.fn(async ({ where }: any) => {
        const numbers = rows.filter((r) => matches(r, where)).map((r) => r.number);
        return { _max: { number: numbers.length ? Math.max(...numbers) : null } };
      }),
      createMany: vi.fn(async ({ data }: { data: RefRow[] }) => {
        rows.push(...db.sneakIn.splice(0));
        let count = 0;
        for (const d of data) {
          const clash = rows.some(
            (r) => r.threadId === d.threadId && r.entityType === d.entityType && (r.number === d.number || r.entityId === d.entityId),
          );
          if (!clash) rows.push(d), count++;
        }
        return { count };
      }),
    },
  };
  return db;
}

/** Leads the owner can see; the agent sees only lead-mine. */
function fakePrisma(opts: { gone?: string[] } = {}) {
  const visibleTo = (where: Record<string, any>, id: string) => !opts.gone?.includes(id) && (!where.assignedToId || id === 'lead-mine');
  return {
    lead: { count: vi.fn(async ({ where }: any) => (visibleTo(where, where.id) ? 1 : 0)) },
    call: { count: vi.fn(async ({ where }: any) => (visibleTo(where.lead, 'lead-mine') ? 1 : 0)) },
    user: { count: vi.fn(async ({ where }: any) => (where.orgId === ORG ? 1 : 0)) },
    // Only meeting-mine passes the visibility filter (asserted below); seq-1 belongs to the office.
    calendarMeeting: { count: vi.fn(async ({ where }: any) => (where.id === 'meeting-mine' ? 1 : 0)) },
    sequence: { count: vi.fn(async ({ where }: any) => (where.id === 'seq-1' && where.orgId === ORG ? 1 : 0)) },
  };
}

function setup(opts: { gone?: string[] } = {}) {
  const db = fakeDb();
  const prisma = fakePrisma(opts);
  const service = new AssistantRefService(db as any, prisma as any);
  return { db, prisma, service };
}

describe('refs: issuing', () => {
  it('numbers records per kind in the order shown, from 1', async () => {
    const s = setup();
    const refs = s.service.forThread(owner, 'thread-1');
    expect([...(await refs.issue('lead', ['lead-a', 'lead-b'])).values()]).toEqual(['L1', 'L2']);
    expect([...(await refs.issue('user', ['user-a'])).values()]).toEqual(['U1']);
    expect([...(await refs.issue('call', ['call-a'])).values()]).toEqual(['C1']);
    expect([...(await refs.issue('lead', ['lead-c'])).values()]).toEqual(['L3']);
  });

  it('a record keeps its ref for the whole chat, across requests', async () => {
    const s = setup();
    await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a', 'lead-b']);
    // A later request (a new turn, or a confirm) builds a fresh table for the same chat.
    const later = await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-b', 'lead-new', 'lead-a']);
    expect(Object.fromEntries(later)).toEqual({ 'lead-a': 'L1', 'lead-b': 'L2', 'lead-new': 'L3' });
    expect(s.db.rows).toHaveLength(3);
  });

  it('each chat counts on its own', async () => {
    const s = setup();
    await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a', 'lead-b']);
    const other = await s.service.forThread(owner, 'thread-2').issue('lead', ['lead-b']);
    expect(other.get('lead-b')).toBe('L1');
  });

  it('writes the office on every row', async () => {
    const s = setup();
    await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a']);
    expect(s.db.rows[0]).toMatchObject({ orgId: ORG, threadId: 'thread-1', entityType: 'lead', entityId: 'lead-a', number: 1 });
  });

  it('a number taken meanwhile by another record is skipped, not shared', async () => {
    const s = setup();
    s.db.sneakIn.push({ orgId: ORG, threadId: 'thread-1', entityType: 'lead', entityId: 'lead-x', number: 1 });
    const refs = await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a']);
    expect(refs.get('lead-a')).toBe('L2');
  });

  it('asks the database nothing for a record it already gave a ref in this request', async () => {
    const s = setup();
    const refs = s.service.forThread(owner, 'thread-1');
    await refs.issue('lead', ['lead-a']);
    s.db.assistantRef.findMany.mockClear();
    await refs.issue('lead', ['lead-a']);
    expect(s.db.assistantRef.findMany).not.toHaveBeenCalled();
  });
});

describe('refs: resolving', () => {
  it('gives back the record behind a ref of this chat', async () => {
    const s = setup();
    await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a']);
    await expect(s.service.forThread(owner, 'thread-1').resolve('lead', 'L1')).resolves.toBe('lead-a');
  });

  it('a ref from another chat means nothing here', async () => {
    const s = setup();
    await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a']);
    await expect(s.service.forThread(owner, 'thread-2').resolve('lead', 'L1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a ref never issued, or of the wrong kind, is NOT_FOUND', async () => {
    const s = setup();
    const refs = s.service.forThread(owner, 'thread-1');
    await refs.issue('lead', ['lead-a']);
    await expect(refs.resolve('lead', 'L9')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(refs.resolve('user', 'L1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(refs.resolve('lead', 'lead-a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('checks again that the user may see the lead, on every use', async () => {
    const s = setup();
    await s.service.forThread(agent, 'thread-1').issue('lead', ['lead-mine', 'lead-theirs']);
    const refs = s.service.forThread(agent, 'thread-1');
    await expect(refs.resolve('lead', 'L1')).resolves.toBe('lead-mine');
    await expect(refs.resolve('lead', 'L2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.prisma.lead.count).toHaveBeenLastCalledWith({ where: expect.objectContaining({ id: 'lead-theirs', orgId: ORG, mergedIntoId: null, assignedToId: 'agent-1' }) });
  });

  it('a lead merged away or deleted since is NOT_FOUND, with the same answer as one never seen', async () => {
    const s = setup({ gone: ['lead-a'] });
    await s.service.forThread(owner, 'thread-1').issue('lead', ['lead-a']);
    const refs = s.service.forThread(owner, 'thread-1');
    const gone = await refs.resolve('lead', 'L1').catch((e) => e.message.replace('L1', 'Lx'));
    const never = await refs.resolve('lead', 'L5').catch((e) => e.message.replace('L5', 'Lx'));
    expect(gone).toBe(never);
  });

  it("a meeting is visible through its lead or to its host, never another agent's", async () => {
    const s = setup();
    await s.service.forThread(agent, 'thread-1').issue('meeting', ['meeting-mine', 'meeting-theirs']);
    const refs = s.service.forThread(agent, 'thread-1');
    await expect(refs.resolve('meeting', 'M1')).resolves.toBe('meeting-mine');
    await expect(refs.resolve('meeting', 'M2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.prisma.calendarMeeting.count).toHaveBeenLastCalledWith({
      where: { id: 'meeting-theirs', orgId: ORG, OR: [{ lead: expect.objectContaining({ assignedToId: 'agent-1' }) }, { hostUserId: 'agent-1' }] },
    });
  });

  it('a sequence is checked against the office; a slot stands for its start time', async () => {
    const s = setup();
    await s.service.forThread(owner, 'thread-1').issue('sequence', ['seq-1', 'seq-gone']);
    await s.service.forThread(owner, 'thread-1').issue('slot', ['2026-11-27T21:00:00.000Z']);
    const refs = s.service.forThread(owner, 'thread-1');
    await expect(refs.resolve('sequence', 'S1')).resolves.toBe('seq-1');
    await expect(refs.resolve('sequence', 'S2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(refs.resolve('slot', 'T1')).resolves.toBe('2026-11-27T21:00:00.000Z');
    await expect(refs.resolve('slot', 'S1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a call is visible only through a lead the user may see', async () => {
    const s = setup();
    await s.service.forThread(agent, 'thread-1').issue('call', ['call-a']);
    await s.service.forThread(agent, 'thread-1').resolve('call', 'C1');
    expect(s.prisma.call.count).toHaveBeenCalledWith({ where: { id: 'call-a', orgId: ORG, lead: expect.objectContaining({ assignedToId: 'agent-1' }) } });
  });
});

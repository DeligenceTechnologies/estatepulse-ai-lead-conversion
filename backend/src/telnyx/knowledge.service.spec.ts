import { describe, expect, it, vi } from 'vitest';
import { MAX_ENTRIES, TOTAL_MAX_CHARS } from './knowledge';
import { KnowledgeService } from './knowledge.service';

const SAVED = [
  { title: 'Areas served', body: 'Plano, Frisco, McKinney and Allen.' },
  { title: 'Commission', body: '3% on the listing side.' },
];

function setup(saved: unknown = SAVED) {
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async (_args: any) => ({ knowledge: saved })),
      upsert: vi.fn(async (_args: any) => ({})),
    },
  };
  return { service: new KnowledgeService(prisma as any), prisma };
}

describe("an organization's knowledge", () => {
  it('is empty when nothing is saved', async () => {
    const s = setup(null);
    expect(await s.service.get('org-1')).toEqual([]);
  });

  it('is empty when the settings row does not exist yet', async () => {
    const prisma = { organizationSetting: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) } };
    const service = new KnowledgeService(prisma as any);
    expect(await service.get('org-1')).toEqual([]);
  });

  it('reports its size and limits alongside the entries', async () => {
    const s = setup();
    const status = await s.service.status('org-1');
    expect(status.entries).toEqual(SAVED);
    expect(status.size).toBe(SAVED.reduce((n, e) => n + e.title.length + e.body.length, 0));
    expect(status.limits).toEqual({
      maxEntries: MAX_ENTRIES,
      titleMaxChars: expect.any(Number),
      bodyMaxChars: expect.any(Number),
      totalMaxChars: TOTAL_MAX_CHARS,
    });
  });
});

describe('tenant isolation', () => {
  it('reads only the organization it was given', async () => {
    const s = setup();
    await s.service.get('org-1');
    expect(s.prisma.organizationSetting.findUnique).toHaveBeenCalledWith({ where: { orgId: 'org-1' }, select: { knowledge: true } });
  });

  it('writes only to the organization it was given', async () => {
    const s = setup();
    await s.service.set('org-1', SAVED);
    expect(s.prisma.organizationSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1' },
        create: expect.objectContaining({ orgId: 'org-1' }),
      }),
    );
  });

  it('ignores an organization id smuggled into the saved entries', async () => {
    const s = setup();
    await s.service.set('org-1', [{ title: 'Areas', body: 'Plano', orgId: 'org-2', organizationId: 'org-2' }]);
    const call = s.prisma.organizationSetting.upsert.mock.calls[0][0] as any;
    expect(call.where).toEqual({ orgId: 'org-1' });
    expect(call.create.orgId).toBe('org-1');
    // The extra keys are dropped by normalization, so they cannot reach the row.
    expect(call.update.knowledge).toEqual([{ title: 'Areas', body: 'Plano' }]);
  });

  it("keeps two organizations' writes apart", async () => {
    const s = setup();
    await s.service.set('org-1', [{ title: 'Commission', body: 'Three percent.' }]);
    await s.service.set('org-2', [{ title: 'Commission', body: 'Two percent.' }]);
    const [first, second] = s.prisma.organizationSetting.upsert.mock.calls.map((c) => c[0] as any);
    expect(first.where.orgId).toBe('org-1');
    expect(first.update.knowledge[0].body).toBe('Three percent.');
    expect(second.where.orgId).toBe('org-2');
    expect(second.update.knowledge[0].body).toBe('Two percent.');
  });
});

describe('saving the knowledge', () => {
  it('stores an empty list as nothing at all, so cleared and never-set are one state', async () => {
    const s = setup();
    const status = await s.service.set('org-1', []);
    expect(status.entries).toEqual([]);
    expect(status.size).toBe(0);
    const call = s.prisma.organizationSetting.upsert.mock.calls[0][0] as any;
    expect(call.update.knowledge).toBeNull();
    expect(call.create.knowledge).toBeNull();
  });

  it('normalizes what it stores rather than trusting the caller', async () => {
    const s = setup();
    await s.service.set('org-1', [{ title: '  Areas\nserved ', body: ' Plano,\tFrisco ' }]);
    const call = s.prisma.organizationSetting.upsert.mock.calls[0][0] as any;
    expect(call.update.knowledge).toEqual([{ title: 'Areas served', body: 'Plano, Frisco' }]);
  });

  it('refuses a list that is over the prompt budget instead of silently saving less', async () => {
    const s = setup();
    const fat = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ title: `Topic ${i}`, body: 'b'.repeat(400) }));
    await expect(s.service.set('org-1', fat)).rejects.toThrow(/under \d+ characters/);
    expect(s.prisma.organizationSetting.upsert).not.toHaveBeenCalled();
  });
});

/**
 * Read these as a record of the behaviour, not as a safety guarantee. A save
 * replaces the whole list in one statement, so there is no partial merge and no
 * torn row — but two owners editing at the same time is LAST WRITE WINS, and
 * the earlier owner's new fact is silently gone. See the review notes: closing
 * that needs an optimistic-concurrency check the editor does not have yet.
 */
describe('two owners saving at once', () => {
  it('never merges one save into the other, because it does not read before it writes', async () => {
    const s = setup();
    await s.service.set('org-1', SAVED);
    expect(s.prisma.organizationSetting.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.organizationSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('writes each save as one complete list, never a partial patch', async () => {
    const s = setup();
    const a = s.service.set('org-1', [{ title: 'Commission', body: 'Three percent.' }]);
    const b = s.service.set('org-1', [{ title: 'Areas served', body: 'Plano.' }, { title: 'Commission', body: 'Two percent.' }]);
    const [first, second] = await Promise.all([a, b]);
    expect(first.entries).toEqual([{ title: 'Commission', body: 'Three percent.' }]);
    expect(second.entries).toHaveLength(2);
    for (const call of s.prisma.organizationSetting.upsert.mock.calls) {
      expect(Array.isArray((call[0] as any).update.knowledge)).toBe(true);
    }
  });

  it('LOSES the earlier save when two owners overlap — last write wins', async () => {
    const s = setup();
    // Owner A loaded the list, added a fact and saved.
    await s.service.set('org-1', [{ title: 'Commission', body: 'Three percent.' }]);
    // Owner B had loaded the list BEFORE A saved, and saves their own version.
    await s.service.set('org-1', [{ title: 'Areas served', body: 'Plano.' }]);

    const writes = s.prisma.organizationSetting.upsert.mock.calls.map((c) => (c[0] as any).update.knowledge);
    const last = writes[writes.length - 1];
    expect(last).toEqual([{ title: 'Areas served', body: 'Plano.' }]);
    // A's fact is not in the final row. This is the documented behaviour, not a
    // property we want: it is the lost update the review flagged.
    expect(JSON.stringify(last)).not.toContain('Three percent.');
  });
});

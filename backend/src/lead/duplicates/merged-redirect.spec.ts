import { describe, expect, it } from 'vitest';
import { leadByPhone, survivorOf, withSurvivors } from './merged-redirect';

type Row = { id: string; orgId: string; normalizedPhone: string | null; mergedIntoId: string | null; createdAt: number };

/** Just enough of prisma.lead for the redirect: where by id / org+phone+merged, newest first. */
const fakeDb = (rows: Row[]) => {
  const match = (r: Row, w: any) =>
    (w.id === undefined || r.id === w.id) &&
    (w.orgId === undefined || r.orgId === w.orgId) &&
    (w.normalizedPhone === undefined || r.normalizedPhone === w.normalizedPhone) &&
    (w.mergedIntoId === undefined || (w.mergedIntoId === null ? r.mergedIntoId === null : r.mergedIntoId !== null));
  const pick = (r: Row | undefined) => (r ? { ...r } : null);
  return {
    lead: {
      findUnique: async ({ where }: any) => pick(rows.find((r) => r.id === where.id)),
      findFirst: async ({ where }: any) => pick(rows.filter((r) => match(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0]),
    },
  } as any;
};

const rows: Row[] = [
  { id: 'survivor', orgId: 'o', normalizedPhone: '+15125550188', mergedIntoId: null, createdAt: 1 },
  { id: 'merged', orgId: 'o', normalizedPhone: '+15125550199', mergedIntoId: 'survivor', createdAt: 2 },
  { id: 'merged-twice', orgId: 'o', normalizedPhone: '+15125550177', mergedIntoId: 'merged', createdAt: 3 },
];

describe('merged-lead redirect', () => {
  it("a merged lead's other number reaches the survivor, through a chain of merges", async () => {
    const db = fakeDb(rows);
    expect(await survivorOf(db, 'merged-twice')).toBe('survivor');
    expect((await leadByPhone(db, 'o', '+15125550199', { id: true }))?.id).toBe('survivor');
    expect((await leadByPhone(db, 'o', '+15125550177', { id: true }))?.id).toBe('survivor');
  });

  it("the survivor's own number finds it directly; an unknown number finds nothing", async () => {
    const db = fakeDb(rows);
    expect((await leadByPhone(db, 'o', '+15125550188', { id: true }))?.id).toBe('survivor');
    expect(await leadByPhone(db, 'o', '+15125550100', { id: true })).toBeNull();
  });

  it('matched leads stand in as their survivors, keeping the key they matched on', async () => {
    const out = await withSurvivors(fakeDb(rows), [
      { id: 'merged', mergedIntoId: 'survivor', normalizedPhone: '+15125550199' },
      { id: 'survivor', mergedIntoId: null, normalizedPhone: '+15125550188' },
    ]);
    expect(out).toEqual([
      { id: 'survivor', mergedIntoId: null, normalizedPhone: '+15125550199' },
      { id: 'survivor', mergedIntoId: null, normalizedPhone: '+15125550188' },
    ]);
  });
});

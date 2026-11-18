import { describe, expect, it, vi } from 'vitest';
import { AirtableSyncService } from './airtable-sync.service';
import { airtableRowKey } from './airtable-records';

/**
 * What happens when Airtable changes a lead that is already past review.
 *
 * The import engine's default is to flag such a change rather than write it,
 * which is right for a spreadsheet an owner is still curating and wrong for a
 * table being synced: the owner asked for edits to flow. So the change is
 * applied, through the very path the Import Review buttons use.
 *
 * There is no rule to choose and nothing to pin about alternatives, because
 * there are none — an edit on either side reaches the other.
 */

const flaggedRow = { id: 'row-1' };

function setup() {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const prisma = {
    sheetImportRow: {
      findMany: vi.fn(async () => [flaggedRow]),
      updateMany: vi.fn(async ({ where, data }: any) => {
        updates.push({ where, data });
        return { count: 1 };
      }),
    },
  };
  const reviews = { resolve: vi.fn(async () => ({ resolved: 1, skipped: [] })) };
  const service = new AirtableSyncService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    reviews as any,
    { record: vi.fn(async () => undefined) } as any,
    { publish: vi.fn() } as any,
    { get: () => 0 } as any,
  );
  const ctx = {
    orgId: 'org-1',
    sourceId: 'src-1',
    credentialId: 'int-1',
    baseId: 'appX',
    tableId: 'tblY',
    config: { direction: 'two_way' as const },
    defaultConsent: 'pending',
    logTag: 'test',
  };
  const rows = [{ key: airtableRowKey('recA'), rowNumber: 1, blank: false, reviewReasons: [] }];
  const counts = { pushedCreated: 0, pushedUpdated: 0, pushFailed: 0, pulled: 0, applied: 0, approved: 0, conflicts: 1, echoes: 0, missing: 0 };
  // settleConflicts is the private step the pull path runs after the engine flags a change.
  const settle = () => (service as unknown as { settleConflicts: (c: unknown, r: unknown, n: unknown) => Promise<void> }).settleConflicts(ctx, rows, counts);
  return { settle, prisma, reviews, updates, counts };
}

describe('an Airtable edit to a lead already past review', () => {
  it('is applied, not left waiting for somebody to click', async () => {
    const s = setup();

    await s.settle();

    const [who, ids, action] = s.reviews.resolve.mock.calls[0] as unknown as [{ userId: string | null }, string[], string];
    expect(action).toBe('apply');
    expect(ids).toEqual(['row-1']);
    // Decided by the sync, not by a person: the history says so rather than
    // crediting whoever happened to be signed in.
    expect(who.userId).toBeNull();
  });

  it('stops being counted as something to decide', async () => {
    const s = setup();

    await s.settle();

    expect(s.counts.conflicts).toBe(0);
  });

  it('only ever settles rows from the records just read', async () => {
    const s = setup();

    await s.settle();

    const where = (s.prisma.sheetImportRow.findMany.mock.calls[0] as unknown as [{ where: any }])[0].where;
    expect(where).toMatchObject({ orgId: 'org-1', leadSourceId: 'src-1', changedAfterReviewAt: { not: null } });
    expect(where.rowKey.in).toEqual([airtableRowKey('recA')]);
  });

  it('writes nothing back, because Airtable already holds the value we just took', async () => {
    const s = setup();

    await s.settle();

    expect(s.updates).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { PrismaService } from './prisma.service';

/**
 * The tenancy guard throws before any query is sent, so these never touch a
 * database — the client is never connected.
 */
describe('tenancy guard on sheet_import_rows', () => {
  const guarded = new PrismaService().withTenancyGuard();

  it('refuses a read scoped only by source', async () => {
    await expect(guarded.sheet_import_rows.findMany({ where: { lead_source_id: 'src-1' } })).rejects.toThrow(
      /Tenancy guard/,
    );
  });

  it('refuses a bulk write scoped only by lead ids', async () => {
    await expect(
      guarded.sheet_import_rows.updateMany({
        where: { lead_id: { in: ['lead-1'] } },
        data: { review_state: 'approved', reviewed_at: new Date() },
      }),
    ).rejects.toThrow(/Tenancy guard/);
  });

  it('refuses a count without a tenant predicate', async () => {
    await expect(guarded.sheet_import_rows.count({ where: { review_state: 'pending' } })).rejects.toThrow(/Tenancy guard/);
  });
});

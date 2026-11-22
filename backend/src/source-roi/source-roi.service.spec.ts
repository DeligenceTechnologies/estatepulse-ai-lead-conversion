import { describe, expect, it, vi } from 'vitest';
import { CONSENT_REVIEW_REASON } from '@/lead/consent';
import { OUTSIDE_IMPORT_REVIEW_SQL } from '@/lead/lead-scope';
import { PERMISSIONS } from '@/role/permissions';
import { MANUAL_ROW_NAME } from './roi-math';
import { SourceRoiEnabledGuard } from './source-roi-enabled.guard';
import { SourceRoiService } from './source-roi.service';

const ORG = '00000000-0000-7000-8000-000000000001';
const SOURCE = '00000000-0000-7000-8000-0000000000a1';
const LEAD = '00000000-0000-7000-8000-0000000000b1';
const owner = { organizationId: ORG, userId: 'owner-1', permissions: [PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE] } as any;

const openLead = { id: LEAD, dealOutcome: null as string | null, dealValue: null as unknown, dealClosedAt: null as Date | null };

function setup(over: { rows?: any[]; source?: any; lead?: any } = {}) {
  const tx = {
    lead: { update: vi.fn(async ({ data }: any) => data) },
  };
  const prisma = {
    $queryRaw: vi.fn(async () => over.rows ?? []),
    $transaction: vi.fn(async (run: (t: unknown) => unknown) => run(tx)),
    leadAppointment: { aggregate: vi.fn(async () => ({ _min: { bookedAt: new Date('2026-09-01T00:00:00Z') } })) },
    leadSource: { findFirst: vi.fn(async (_args: any) => (over.source === undefined ? { id: SOURCE, archivedAt: null } : over.source)) },
    leadSourceSpend: { upsert: vi.fn(async () => undefined), deleteMany: vi.fn(async () => ({ count: 1 })) },
    lead: { findFirst: vi.fn(async (_args: any) => (over.lead === undefined ? openLead : over.lead)) },
  };
  const ledger = { topUp: vi.fn(async () => undefined) };
  const state = { record: vi.fn(async () => undefined) };
  return { service: new SourceRoiService(prisma as any, ledger as any, state as any), prisma, tx, ledger, state };
}

const dbRow = (over: Record<string, unknown>) => ({
  source_id: SOURCE,
  name: 'Zillow',
  provider: 'WEBHOOK',
  archived: false,
  leads: 0,
  contacted: 0,
  qualified: 0,
  booked: 0,
  held: 0,
  no_show: 0,
  won: 0,
  lost: 0,
  revenue: 0,
  comm_cost: 0,
  spend: 0,
  ...over,
});

describe('SourceRoiService.report', () => {
  it('tops the ledger up, then turns the counted rows into a table with totals', async () => {
    const { service, ledger } = setup({
      rows: [
        dbRow({ leads: 10, contacted: 8, qualified: 4, booked: 2, held: 1, no_show: 1, won: 1, revenue: 9000, spend: 600, comm_cost: 40 }),
        dbRow({ source_id: null, name: null, provider: null, leads: 3, contacted: 3 }),
      ],
    });
    const report = await service.report(ORG, '2026-10', '2026-11');
    expect(ledger.topUp).toHaveBeenCalledWith(ORG);
    expect(report).toMatchObject({ from: '2026-10', to: '2026-11', months: 2, currency: 'USD', appointmentsTrackedSince: '2026-09-01T00:00:00.000Z' });
    expect(report.rows[0]).toMatchObject({ name: 'Zillow', noShow: 1, totalCost: 640, costPerAppointment: 320, costPerClosing: 640, contactRate: 0.8 });
    expect(report.rows[1]).toMatchObject({ name: MANUAL_ROW_NAME, spendEditable: false, costPerAppointment: null });
    expect(report.totals).toMatchObject({ leads: 13, contacted: 11, spend: 600, totalCost: 640, revenue: 9000 });
  });

  it('reads the cohort by the office clock and leaves out leads still held for review', async () => {
    const { service, prisma } = setup();
    await service.report(ORG, '2026-11', '2026-11');
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = strings.join('?');
    // The review scope is the shared fragment, not a second copy of the rule.
    expect(values).toContain(OUTSIDE_IMPORT_REVIEW_SQL);
    expect(OUTSIDE_IMPORT_REVIEW_SQL.sql).toContain("r.review_state IN ('pending','rejected')");
    expect(OUTSIDE_IMPORT_REVIEW_SQL.sql).toContain('leads.review_reasons @> ARRAY[');
    expect(OUTSIDE_IMPORT_REVIEW_SQL.values).toEqual([CONSENT_REVIEW_REASON]);
    expect(sql).toContain('AT TIME ZONE (SELECT z FROM tz)');
    // A cancelled or still-unconfirmed booking is not an appointment booked.
    expect(sql).toContain("bool_or(a.status = 'scheduled') AS booked");
    expect(values).toContain('2026-11-01');
    expect(values).toContain('2026-12-01');
    // Every read is scoped to the organization: nothing in the query is unscoped.
    expect(values.filter((v) => v === ORG).length).toBeGreaterThanOrEqual(6);
  });

  it('refuses a backwards range before touching the database', async () => {
    const { service, prisma, ledger } = setup();
    await expect(service.report(ORG, '2026-12', '2026-11')).rejects.toThrow();
    expect(ledger.topUp).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('SourceRoiService.setSpend', () => {
  it('saves the month as its first day, with who set it', async () => {
    const { service, prisma } = setup();
    await service.setSpend(owner, { leadSourceId: SOURCE, month: '2026-11', amount: 1500.5 });
    const key = { orgId: ORG, leadSourceId: SOURCE, month: new Date('2026-11-01T00:00:00.000Z') };
    expect(prisma.leadSourceSpend.upsert).toHaveBeenCalledWith({
      where: { orgId_leadSourceId_month: key },
      create: { ...key, amount: 1500.5, updatedById: 'owner-1' },
      update: { amount: 1500.5, updatedById: 'owner-1' },
    });
  });

  it('null or zero clears the month', async () => {
    const { service, prisma } = setup();
    await service.setSpend(owner, { leadSourceId: SOURCE, month: '2026-11', amount: null });
    await service.setSpend(owner, { leadSourceId: SOURCE, month: '2026-11', amount: 0 });
    expect(prisma.leadSourceSpend.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.leadSourceSpend.upsert).not.toHaveBeenCalled();
  });

  it("another organization's source is not found", async () => {
    const { service, prisma } = setup({ source: null });
    await expect(service.setSpend(owner, { leadSourceId: SOURCE, month: '2026-11', amount: 10 })).rejects.toThrow('No such lead source');
    expect(prisma.leadSource.findFirst.mock.calls[0][0].where).toEqual({ id: SOURCE, orgId: ORG });
    expect(prisma.leadSourceSpend.upsert).not.toHaveBeenCalled();
  });

  it('a removed source takes no new spend, but its old spend can still be cleared', async () => {
    const { service, prisma } = setup({ source: { id: SOURCE, archivedAt: new Date() } });
    await expect(service.setSpend(owner, { leadSourceId: SOURCE, month: '2026-11', amount: 10 })).rejects.toThrow('removed');
    await service.setSpend(owner, { leadSourceId: SOURCE, month: '2026-11', amount: null });
    expect(prisma.leadSourceSpend.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('SourceRoiService deal outcome', () => {
  it('won keeps the value, closes now, and is logged on the lead without touching its status', async () => {
    const { service, tx, state } = setup();
    const deal = await service.setDeal(owner, LEAD, { outcome: 'won', value: 12000 });
    const data = tx.lead.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ dealOutcome: 'won', dealValue: 12000, dealClosedAt: expect.any(Date) });
    expect(data).not.toHaveProperty('status');
    expect(deal).toMatchObject({ outcome: 'won', value: 12000 });
    expect(state.record).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: LEAD, type: 'deal_outcome_set', actor: { type: 'user', id: 'owner-1' } }),
      tx,
    );
  });

  it('lost has no value, whatever was sent', async () => {
    const { service, tx } = setup();
    await service.setDeal(owner, LEAD, { outcome: 'lost', value: 500 });
    expect(tx.lead.update.mock.calls[0][0].data).toMatchObject({ dealOutcome: 'lost', dealValue: null });
  });

  it('null reopens the deal and clears all three fields', async () => {
    const { service, tx, state } = setup({ lead: { ...openLead, dealOutcome: 'won', dealValue: '9000.00', dealClosedAt: new Date('2026-11-01T00:00:00Z') } });
    expect(await service.setDeal(owner, LEAD, { outcome: null })).toEqual({ outcome: null, value: null, closedAt: null });
    expect(tx.lead.update.mock.calls[0][0].data).toEqual({ dealOutcome: null, dealValue: null, dealClosedAt: null });
    expect(state.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deal_outcome_cleared', payload: expect.objectContaining({ previous: { outcome: 'won', value: 9000 } }) }),
      tx,
    );
  });

  it('a won deal keeps its value when the value is left out; an explicit null clears it', async () => {
    const won = { ...openLead, dealOutcome: 'won', dealValue: '12000.00', dealClosedAt: new Date('2026-11-01T00:00:00Z') };
    const { service, tx } = setup({ lead: won });
    await service.setDeal(owner, LEAD, { outcome: 'won', closedAt: '2026-10-15T00:00:00.000Z' });
    expect(tx.lead.update.mock.calls[0][0].data.dealValue).toBe(12000);
    await service.setDeal(owner, LEAD, { outcome: 'won', value: null });
    expect(tx.lead.update.mock.calls[1][0].data.dealValue).toBeNull();
    await service.setDeal(owner, LEAD, { outcome: 'lost' });
    expect(tx.lead.update.mock.calls[2][0].data.dealValue).toBeNull();
  });

  it('editing a closed deal keeps its closing date unless a new one is sent', async () => {
    const closed = new Date('2026-11-01T00:00:00Z');
    const { service, tx } = setup({ lead: { ...openLead, dealOutcome: 'won', dealValue: '1.00', dealClosedAt: closed } });
    await service.setDeal(owner, LEAD, { outcome: 'won', value: 2 });
    expect(tx.lead.update.mock.calls[0][0].data.dealClosedAt).toBe(closed);
    await service.setDeal(owner, LEAD, { outcome: 'won', value: 2, closedAt: '2026-10-15T00:00:00.000Z' });
    expect(tx.lead.update.mock.calls[1][0].data.dealClosedAt).toEqual(new Date('2026-10-15T00:00:00.000Z'));
  });

  it('refuses a closing date in the future', async () => {
    const { service, prisma } = setup();
    await expect(service.setDeal(owner, LEAD, { outcome: 'won', closedAt: '2999-01-01T00:00:00.000Z' })).rejects.toThrow('future');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a closing date that is not a date, as a bad request', async () => {
    const { service, prisma } = setup();
    await expect(service.setDeal(owner, LEAD, { outcome: 'won', closedAt: '2026-W47' })).rejects.toThrow('not a date');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a lead the caller cannot see, or one still in review, is not found', async () => {
    const { service, prisma } = setup({ lead: null });
    await expect(service.getDeal(owner, LEAD)).rejects.toThrow('No such lead');
    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: LEAD, orgId: ORG, sheetImportRows: expect.anything(), NOT: expect.anything() });
    await expect(service.getDeal(owner, 'nope')).rejects.toThrow('No such lead');
    expect(prisma.lead.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('SourceRoiEnabledGuard', () => {
  const guard = (on: boolean) => new SourceRoiEnabledGuard({ get: () => on } as any);

  it('lets a request through while the flag is on', () => {
    expect(guard(true).canActivate()).toBe(true);
  });

  it('answers 404 while it is off', () => {
    try {
      guard(false).canActivate();
      throw new Error('expected a 404');
    } catch (error: any) {
      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ error: { code: 'SOURCE_ROI_DISABLED' } });
    }
  });
});

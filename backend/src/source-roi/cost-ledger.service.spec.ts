import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RATES, METRIC } from './cost-rates';
import { CostLedgerService } from './cost-ledger.service';

const ORG = '00000000-0000-7000-8000-000000000001';

interface Options {
  calls?: any[];
  messages?: any[];
  settings?: { callRatePerMinute: unknown; smsRatePerSegment: unknown } | null;
  enabled?: boolean;
  newest?: Date | null;
}

/** A prisma whose ledger remembers what was written, so a second pass finds nothing left to cost. */
function setup({ calls = [], messages = [], settings = null, enabled = true, newest = null }: Options = {}) {
  const ledger: any[] = [];
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const deletes: { sql: string; values: unknown[] }[] = [];
  const has = (metric: string, id: string) => ledger.some((row) => row.metric === metric && row.sourceId === id);
  const prisma = {
    organization: { findMany: vi.fn(async () => [{ id: ORG }]) },
    organizationSetting: {
      findUnique: vi.fn(async () => settings),
      upsert: vi.fn(async (args: any) => {
        settings = { callRatePerMinute: null, smsRatePerSegment: null, ...settings, ...args.update };
      }),
    },
    usageRecord: {
      aggregate: vi.fn(async () => ({ _max: { occurredAt: newest } })),
      createMany: vi.fn(async ({ data }: { data: any[] }) => {
        const fresh = data.filter((row) => !has(row.metric, row.sourceId));
        ledger.push(...fresh);
        return { count: fresh.length };
      }),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      deletes.push({ sql: strings.join('?'), values });
      return 0;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      sqls.push(sql);
      params.push(values);
      return sql.includes('FROM calls')
        ? calls.filter((c) => !has(METRIC.CALL_MINUTES, c.id))
        : messages.filter((m) => !has(METRIC.SMS_SEGMENTS, m.id));
    }),
  };
  const config = { get: vi.fn(() => enabled) };
  return { service: new CostLedgerService(prisma as any, config as any), prisma, ledger, sqls, params, deletes };
}

const at = new Date('2026-11-10T15:00:00Z');
const call = (id: string, seconds: number) => ({ id, lead_id: 'lead-1', provider: 'telnyx', duration_seconds: seconds, occurred_at: at });
const text = (id: string, body: string) => ({ id, lead_id: 'lead-1', body, occurred_at: at });

describe('CostLedgerService.reconcile', () => {
  it('costs a call by the minute and a text by the segment, at the default rates', async () => {
    const { service, ledger } = setup({ calls: [call('c1', 90)], messages: [text('m1', 'a'.repeat(161))] });
    expect(await service.reconcile(ORG)).toBe(2);
    expect(ledger[0]).toMatchObject({
      orgId: ORG,
      leadId: 'lead-1',
      metric: METRIC.CALL_MINUTES,
      sourceId: 'c1',
      quantity: 1.5,
      unitRate: DEFAULT_RATES.callRatePerMinute,
      amount: 0.135,
      provider: 'telnyx',
      occurredAt: at,
    });
    expect(ledger[1]).toMatchObject({ metric: METRIC.SMS_SEGMENTS, sourceId: 'm1', quantity: 2, amount: 0.016 });
  });

  it("uses the organization's own rate where it set one", async () => {
    const { service, ledger } = setup({ calls: [call('c1', 60)], settings: { callRatePerMinute: '0.2500', smsRatePerSegment: null } });
    await service.reconcile(ORG);
    expect(ledger[0]).toMatchObject({ unitRate: 0.25, amount: 0.25 });
  });

  it('a second pass costs nothing twice', async () => {
    const { service, ledger } = setup({ calls: [call('c1', 60)], messages: [text('m1', 'hi')] });
    await service.reconcile(ORG);
    expect(await service.reconcile(ORG)).toBe(0);
    expect(ledger).toHaveLength(2);
  });

  it('only reads answered calls, and texts the carrier handled', async () => {
    const { service, sqls } = setup();
    await service.reconcile(ORG);
    const [calls, messages] = sqls;
    expect(calls).toContain("c.status = 'completed' AND c.duration_seconds > 0");
    expect(messages).toContain("m.direction = 'inbound' OR (m.provider_message_id IS NOT NULL AND m.delivery_status <> 'failed')");
    for (const sql of sqls) expect(sql).toContain('NOT EXISTS (SELECT 1 FROM usage_records u');
  });

  it('starts from the beginning the first time, and a little before the newest row after that', async () => {
    const first = setup();
    await first.service.reconcile(ORG);
    expect(first.params[0]).toContain(null);

    const newest = new Date('2026-11-10T00:00:00Z');
    const later = setup({ newest });
    await later.service.reconcile(ORG);
    expect(later.params[0]).toContainEqual(new Date('2026-11-08T00:00:00Z'));
  });

  it('a full pass reads everything, whatever the newest row is', async () => {
    const { service, prisma, params } = setup({ newest: new Date('2026-11-10T00:00:00Z') });
    await service.reconcile(ORG, 1, true);
    expect(prisma.usageRecord.aggregate).not.toHaveBeenCalled();
    for (const values of params) expect(values).toContain(null);
  });

  it('takes back the estimate of a text that failed after it was costed', async () => {
    const { service, deletes } = setup();
    await service.reconcile(ORG);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toContain('DELETE FROM usage_records u');
    expect(deletes[0].sql).toContain('u.is_estimated');
    expect(deletes[0].sql).toContain("m.direction = 'outbound' AND m.delivery_status = 'failed'");
    expect(deletes[0].values).toContain(ORG);
    expect(deletes[0].values).toContain(METRIC.SMS_SEGMENTS);
  });
});

describe('CostLedgerService.topUp', () => {
  it('skips the pass when the organization was reconciled moments ago', async () => {
    const { service, prisma } = setup({ calls: [call('c1', 60)] });
    await service.topUp(ORG);
    await service.topUp(ORG);
    expect(prisma.organizationSetting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('CostLedgerService.reconcileAll', () => {
  it('does nothing while the flag is off', async () => {
    const { service, prisma } = setup({ enabled: false, calls: [call('c1', 60)] });
    await service.reconcileAll();
    expect(prisma.organization.findMany).not.toHaveBeenCalled();
    expect(prisma.usageRecord.createMany).not.toHaveBeenCalled();
  });

  it('costs every organization when it is on', async () => {
    const { service, ledger } = setup({ calls: [call('c1', 60)] });
    await service.reconcileAll();
    expect(ledger).toHaveLength(1);
  });

  it('the first pass after a start is a full one, the next ones are quick', async () => {
    const { service, prisma } = setup({ newest: new Date('2026-11-10T00:00:00Z') });
    await service.reconcileAll();
    expect(prisma.usageRecord.aggregate).not.toHaveBeenCalled();
    await service.reconcileAll();
    expect(prisma.usageRecord.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe('CostLedgerService rates', () => {
  it('reports the defaults, and which rates are the organization’s own', async () => {
    const { service } = setup({ settings: { callRatePerMinute: '0.1200', smsRatePerSegment: null } });
    expect(await service.getRates(ORG)).toEqual({
      callRatePerMinute: 0.12,
      smsRatePerSegment: DEFAULT_RATES.smsRatePerSegment,
      custom: { callRatePerMinute: true, smsRatePerSegment: false },
      defaults: DEFAULT_RATES,
    });
  });

  it('null puts a rate back on the default; a field left out is not touched', async () => {
    const { service, prisma } = setup({ settings: { callRatePerMinute: '0.1200', smsRatePerSegment: '0.0100' } });
    const rates = await service.setRates(ORG, { callRatePerMinute: null });
    expect(prisma.organizationSetting.upsert.mock.calls[0][0].update).toEqual({ callRatePerMinute: null });
    expect(rates.custom).toEqual({ callRatePerMinute: false, smsRatePerSegment: true });
  });

  it('refuses a negative rate', async () => {
    const { service, prisma } = setup();
    await expect(service.setRates(ORG, { smsRatePerSegment: -1 })).rejects.toThrow();
    expect(prisma.organizationSetting.upsert).not.toHaveBeenCalled();
  });
});

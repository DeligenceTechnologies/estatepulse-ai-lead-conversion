import { describe, expect, it, vi } from 'vitest';
import { AUTO_APPROVE, AirtableSyncService, pendingRowKey } from './airtable-sync.service';
import { airtableRowKey, buildAirtableRow, outboundHash, rowContext } from './airtable-records';
import { AirtableApiError, type AirtableField, type AirtableRecord } from './types';

/**
 * AirtableSyncService: the push/pull round trip.
 *
 * Loop prevention, end to end: push a lead to Airtable, then feed the very
 * record Airtable handed back into the pull side and show that nothing is
 * written a second time.
 *
 * This is the test the integration was missing. The fingerprint comparison that
 * drops an echo had been written across two DIFFERENT hash functions — the
 * outbound one, keyed by Airtable field id, against the import engine's, keyed
 * by lead field — so it could never be true and every push came back round as a
 * change. Both sides of that comparison now come from buildRow, and the case
 * below is what holds them there.
 */

const FIELDS: AirtableField[] = [
  { id: 'fldName', name: 'Name', type: 'singleLineText' },
  { id: 'fldEmail', name: 'Email', type: 'email' },
  { id: 'fldStatus', name: 'EstatePulse status', type: 'singleSelect' },
  { id: 'fldLink', name: 'Open in EstatePulse', type: 'url' },
];
const MAPPINGS = [
  { source_field_key: 'fldName', target_field: 'first_name', transform: { kind: 'text' as const } },
  { source_field_key: 'fldEmail', target_field: 'email', transform: { kind: 'text' as const } },
];
const RECORD: AirtableRecord = { id: 'recA', fields: { fldName: 'Ana', fldEmail: 'ana@example.test' } };
const KEY = airtableRowKey('recA');

const CTX = {
  orgId: 'org-1',
  sourceId: 'src-1',
  credentialId: 'int-1',
  baseId: 'appX',
  tableId: 'tblY',
  config: { direction: 'two_way' as const, exportScope: 'this_table' as const, writeBack: [] },
  defaultConsent: 'pending',
  logTag: 'test',
};

const zero = () => ({ pushedCreated: 0, pushedUpdated: 0, pushFailed: 0, pulled: 0, applied: 0, approved: 0, conflicts: 0, echoes: 0, missing: 0 });

function setup(opts: { tracked?: Record<string, unknown>[]; returns?: AirtableRecord[]; due?: number; unlinked?: boolean; createError?: unknown; createReturns?: AirtableRecord[]; retryable?: unknown[]; appUrl?: string } = {}) {
  const updates: { data: Record<string, unknown> }[] = [];
  const sql: string[] = [];
  const dueIds = Array.from({ length: opts.due ?? 1 }, (_, i) => ({ id: `row-${i + 1}` }));
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => { sql.push(strings.join('?')); return dueIds; }),
    leadSourceFieldMapping: { findMany: vi.fn(async () => MAPPINGS.map((m) => ({ sourceFieldKey: m.source_field_key, targetField: m.target_field, transform: m.transform }))) },
    sheetImportRow: {
      findMany: vi.fn(async (args: any) => {
        // pushFailed is the only caller that asks for the attempt count.
        if (args?.select?.pushAttempts) return (args.where.id.in as string[]).map((id) => ({ id, pushAttempts: 0 }));
        // Claims due for another create attempt.
        if (args?.where?.rowKey?.startsWith) return opts.retryable ?? [];
        return opts.tracked ?? [{ id: 'row-1', rowKey: KEY, pushedHash: null, pushedAt: null, contentHash: null, leadId: 'lead-1', lead: LEAD }];
      }),
      updateMany: vi.fn(async ({ data }: any) => { updates.push({ data }); return { count: 1 }; }),
      create: vi.fn(async () => ({ id: 'row-1' })),
      upsert: vi.fn(async () => ({ id: 'claim-1' })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    call: { groupBy: vi.fn(async () => []) },
    lead: { findMany: vi.fn(async () => (opts.unlinked ? [LEAD] : [])), updateMany: vi.fn(async () => ({ count: 1 })) },
    integration: { count: vi.fn(async () => 1) },
    $executeRaw: vi.fn(async () => 1),
  };
  const client = {
    baseSchema: vi.fn(async () => [{ id: 'tblY', name: 'Leads', fields: FIELDS }]),
    updateRecords: vi.fn(async () => opts.returns ?? [RECORD]),
    createRecords: vi.fn(async () => {
      if (opts.createError) throw opts.createError;
      return opts.createReturns ?? [RECORD];
    }),
  };
  const connections = { withAccessToken: vi.fn(async (_o: string, _c: string, fn: (t: string) => Promise<unknown>) => fn('tok')) };
  const importer = { importRows: vi.fn(async () => undefined) };
  const service = new AirtableSyncService(
    prisma as any, connections as any, client as any, importer as any,
    { resolve: vi.fn() } as any, { record: vi.fn(async () => undefined) } as any,
    { publish: vi.fn() } as any, { get: (k: string) => (k === 'APP_URL' ? opts.appUrl : 0) } as any,
  );
  return { service, prisma, client, importer, updates, sql };
}

const LEAD = {
  id: 'lead-1', externalLeadId: 'recA', firstName: 'Ana', lastName: null,
  email: 'ana@example.test', phone: null, location: null, status: 'engaged', dncStatus: true,
  minBudget: null, maxBudget: null, bedrooms: null, motivation: null, updatedAt: new Date(),
};

describe('an EstatePulse write coming back from Airtable', () => {
  it('records the pushed record in the fingerprint a later read will produce', async () => {
    const s = setup();

    await s.service.pushChanges(CTX as never, zero());

    expect(s.client.updateRecords).toHaveBeenCalledOnce();
    const stored = s.updates.at(-1)!.data;
    // What a read of that same record builds — not the outbound hash.
    const expected = buildAirtableRow(RECORD, 1, rowContext(FIELDS, MAPPINGS)).hash;
    expect(stored.contentHash).toBe(expected);
  });

  it('drops it as an echo instead of importing it again', async () => {
    const pushed = setup();
    await pushed.service.pushChanges(CTX as never, zero());
    const contentHash = pushed.updates.at(-1)!.data.contentHash as string;

    // The webhook fires and the same record is read back.
    const pull = setup({ tracked: [{ id: 'row-1', rowKey: KEY, pushedAt: new Date(), contentHash, leadId: 'lead-1' }] });
    const counts = zero();
    await pull.service.applyRecords(CTX as never, [RECORD], counts);

    expect(counts.echoes).toBe(1);
    expect(counts.applied).toBe(0);
    // Nothing reaches the import engine, so no change, no review row, no loop.
    expect(pull.importer.importRows).not.toHaveBeenCalled();
  });

  it('still imports a record somebody really edited', async () => {
    const edited: AirtableRecord = { id: 'recA', fields: { fldName: 'Anna', fldEmail: 'ana@example.test' } };
    const contentHash = buildAirtableRow(RECORD, 1, rowContext(FIELDS, MAPPINGS)).hash;
    const pull = setup({ tracked: [{ id: 'row-1', rowKey: KEY, pushedAt: new Date(), contentHash, leadId: 'lead-1' }] });
    const counts = zero();

    await pull.service.applyRecords(CTX as never, [edited], counts);

    expect(counts.echoes).toBe(0);
    expect(pull.importer.importRows).toHaveBeenCalledOnce();
  });

  it('never compares the outbound fingerprint with the import engine’s', () => {
    // The two live in different spaces over different data. Comparing them is
    // what made loop prevention a no-op, so it is pinned here rather than left
    // to be rediscovered.
    const out = outboundHash({ fldName: 'Ana', fldEmail: 'ana@example.test' });
    const read = buildAirtableRow(RECORD, 1, rowContext(FIELDS, MAPPINGS)).hash;
    expect(out).not.toBe(read);
  });
});

describe('choosing which rows to push', () => {
  it('asks the database for rows whose lead actually moved, oldest first', async () => {
    const s = setup();

    await s.service.pushChanges(CTX as never, zero());

    const q = s.sql.join(' ');
    // Comparing two columns is the whole point: a plain findMany cannot do it,
    // and without it the slice fills up with rows that are already in step.
    expect(q).toContain('l.updated_at > r.pushed_at');
    // A conflict settled our way clears the fingerprint; that must re-queue it.
    expect(q).toContain('r.pushed_hash IS NULL');
    // Oldest first is what stops one end of the table starving the other.
    expect(q).toContain('ORDER BY r.pushed_at ASC NULLS FIRST');
  });

  it('reports a backlog when the slice fills, so the next run comes straight back', async () => {
    // Comfortably past any slice cap.
    const s = setup({ due: 500 });

    await expect(s.service.pushChanges(CTX as never, zero())).resolves.toBe(true);
  });

  it('reports none when the slice did not fill', async () => {
    const s = setup({ due: 1 });

    await expect(s.service.pushChanges(CTX as never, zero())).resolves.toBe(false);
  });
});

describe('which leads are written out', () => {
  const scoped = (exportScope: 'this_table' | 'all_leads') => ({ ...CTX, config: { ...CTX.config, exportScope } });
  const whereOf = (s: ReturnType<typeof setup>) => (s.prisma.lead.findMany.mock.calls[0] as unknown as [{ where: any }])[0].where;

  it('keeps to the leads this table produced, by default', async () => {
    const s = setup();

    await s.service.pushChanges(scoped('this_table') as never, zero());

    // Two-way sync means this table and its own leads; it must not start
    // publishing the rest of the organization into somebody's base.
    expect(whereOf(s).leadSourceId).toBe('src-1');
  });

  it('covers the whole organization when the owner asks for it', async () => {
    const s = setup();

    await s.service.pushChanges(scoped('all_leads') as never, zero());

    expect(whereOf(s).leadSourceId).toBeUndefined();
    expect(whereOf(s).orgId).toBe('org-1');
  });

  it('skips only leads another Airtable table already owns', async () => {
    const s = setup();

    await s.service.pushChanges(scoped('all_leads') as never, zero());

    // Not { none: {} }: a lead that came from a sheet, a CRM or a file already
    // carries a tracking row, and excluding those would drop them for a reason
    // that has nothing to do with Airtable.
    expect(whereOf(s).sheetImportRows).toEqual({ none: { leadSource: { provider: 'AIRTABLE' } } });
  });
});

describe('creating a record in Airtable', () => {
  const unlinkedOnly = { tracked: [] as Record<string, unknown>[], unlinked: true, due: 0 };

  it('claims the lead before Airtable is asked to create anything', async () => {
    const s = setup(unlinkedOnly);

    await s.service.pushChanges(CTX as never, zero());

    const claim = s.prisma.sheetImportRow.upsert.mock.calls[0] as unknown as [{ create: any }];
    expect(claim[0].create.rowKey).toBe(pendingRowKey('lead-1'));
    // Carried from the start: a claim that never settles is a visible failure.
    expect(claim[0].create.pushErrorCode).toBe('AIRTABLE_CREATE_UNCONFIRMED');
    // Order is the whole point — a claim made afterwards would protect nothing.
    expect(s.prisma.sheetImportRow.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      s.client.createRecords.mock.invocationCallOrder[0],
    );
  });

  it('backs the claim off when Airtable refuses, rather than retrying it forever', async () => {
    const s = setup({ ...unlinkedOnly, createError: new AirtableApiError('BAD_REQUEST', 'bad field', 422) });

    await s.service.pushChanges(CTX as never, zero());

    // Releasing the claim would make the lead look unlinked again, and the next
    // slice would try at once — every slice, with nothing slowing it down.
    expect(s.prisma.sheetImportRow.deleteMany).not.toHaveBeenCalled();
    const parked = s.updates.find((u) => u.data.pushErrorCode === 'BAD_REQUEST');
    expect(parked?.data.pushAttempts).toBe(1);
    expect(parked?.data.pushAvailableAt).toBeInstanceOf(Date);
  });

  it('settles nothing when Airtable answers with a different number of records', async () => {
    // One create sent, none returned. Which record belongs to which lead is now
    // unknowable, and guessing writes one person into another person's record.
    const s = setup({ ...unlinkedOnly, createReturns: [] });

    await s.service.pushChanges(CTX as never, zero());

    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the claim when the create goes unanswered, so no duplicate is written', async () => {
    const s = setup({ ...unlinkedOnly, createError: new AirtableApiError('UNAVAILABLE', 'Airtable did not respond', 0) });

    await expect(s.service.pushChanges(CTX as never, zero())).rejects.toBeInstanceOf(AirtableApiError);

    // Nobody knows whether that record exists. Releasing the claim would let
    // the next slice create a second one.
    expect(s.prisma.sheetImportRow.deleteMany).not.toHaveBeenCalled();
  });
});

describe('reporting progress back to Airtable', () => {
  const reporting = { ...CTX, config: { ...CTX.config, writeBack: [{ key: 'ep_status', fieldId: 'fldStatus' }] } };

  it('writes the chosen EstatePulse field into the column the owner picked', async () => {
    const s = setup();

    await s.service.pushChanges(reporting as never, zero());

    const sent = (s.client.updateRecords.mock.calls[0] as unknown as [string, string, string, { fields: Record<string, unknown> }[]])[3];
    // The lead's own progress, in the owner's column — alongside the mapped
    // contact details, through the very same write.
    expect(sent[0].fields.fldStatus).toBe('engaged');
    expect(sent[0].fields.fldName).toBe('Ana');
  });

  it('writes nothing extra when the owner chose nothing', async () => {
    const s = setup();

    await s.service.pushChanges(CTX as never, zero());

    const sent = (s.client.updateRecords.mock.calls[0] as unknown as [string, string, string, { fields: Record<string, unknown> }[]])[3];
    expect(sent[0].fields).not.toHaveProperty('fldStatus');
  });

  it('ignores a column that is no longer in the table', async () => {
    const gone = { ...CTX, config: { ...CTX.config, writeBack: [{ key: 'ep_status', fieldId: 'fldDeleted' }] } };
    const s = setup();

    await expect(s.service.pushChanges(gone as never, zero())).resolves.toBeDefined();

    const sent = (s.client.updateRecords.mock.calls[0] as unknown as [string, string, string, { fields: Record<string, unknown> }[]])[3];
    expect(sent[0].fields).not.toHaveProperty('fldDeleted');
  });
});

describe('linking an Airtable row back to the lead', () => {
  it('sends the same URL the assignment email uses, so both open the dossier', async () => {
    const linked = { ...CTX, config: { ...CTX.config, writeBack: [{ key: 'ep_link', fieldId: 'fldLink' }] } };
    const s = setup({ appUrl: 'https://app.test' });

    await s.service.pushChanges(linked as never, zero());

    const sent = (s.client.updateRecords.mock.calls[0] as unknown as [string, string, string, { fields: Record<string, unknown> }[]])[3];
    expect(sent[0].fields.fldLink).toBe('https://app.test/leads?lead=lead-1');
  });

  it('sends nothing rather than a link to nowhere when there is no APP_URL', async () => {
    const linked = { ...CTX, config: { ...CTX.config, writeBack: [{ key: 'ep_link', fieldId: 'fldLink' }] } };
    const s = setup();

    await s.service.pushChanges(linked as never, zero());

    const sent = (s.client.updateRecords.mock.calls[0] as unknown as [string, string, string, { fields: Record<string, unknown> }[]])[3];
    expect(sent[0].fields.fldLink).toBeNull();
  });
});

describe('a lead that was deleted', () => {
  it('lets the record through again, so the engine can relink the orphaned row', async () => {
    // The owner deleted the lead; the tracking row stays behind with lead_id
    // null. The record itself never changed, so the fingerprint still matches —
    // and skipping on that alone would strand it forever.
    const contentHash = buildAirtableRow(RECORD, 1, rowContext(FIELDS, MAPPINGS)).hash;
    const s = setup({ tracked: [{ id: 'row-1', rowKey: KEY, pushedAt: null, contentHash, leadId: null }] });

    await s.service.applyRecords(CTX as never, [RECORD], zero());

    expect(s.importer.importRows).toHaveBeenCalledOnce();
  });

  it('still skips it while the lead is there', async () => {
    const contentHash = buildAirtableRow(RECORD, 1, rowContext(FIELDS, MAPPINGS)).hash;
    const s = setup({ tracked: [{ id: 'row-1', rowKey: KEY, pushedAt: null, contentHash, leadId: 'lead-1' }] });

    await s.service.applyRecords(CTX as never, [RECORD], zero());

    expect(s.importer.importRows).not.toHaveBeenCalled();
  });
});

describe('a record that arrives during a sync', () => {
  const clean = {
    rowNumber: 1,
    blank: false,
    reviewReasons: [] as string[],
    lead: { normalized_phone: '+15551234567' },
  };
  const settled = { dnc: false, duplicate: false };
  const approve = (row: unknown, flags = settled) => AUTO_APPROVE.rule(row as never, flags);

  it('goes straight to outreach when there is nothing to decide about it', () => {
    expect(approve(clean)).toBe(true);
  });

  it('is recorded as the sync deciding, not as whoever last signed in', () => {
    expect(AUTO_APPROVE.by.userId).toBeNull();
    // No outreach request: a lead that arrives now is released now.
    expect(AUTO_APPROVE.outreach).toBeUndefined();
  });

  it('waits for a person when it inherited do-not-contact', () => {
    expect(approve(clean, { dnc: true, duplicate: false })).toBe(false);
  });

  it('waits for a person when it collides with a lead already here', () => {
    expect(approve(clean, { dnc: false, duplicate: true })).toBe(false);
  });

  it('waits for a person when the row builder raised anything', () => {
    expect(approve({ ...clean, reviewReasons: ['Phone number could not be read'] })).toBe(false);
  });

  it('waits for a person when the phone cannot be dialled', () => {
    // Approving would be worse than holding: the lead would leave Import
    // Review, never be called, and nobody would be told.
    expect(approve({ ...clean, lead: { normalized_phone: null } })).toBe(false);
  });
});

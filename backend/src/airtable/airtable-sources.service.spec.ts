import { describe, expect, it, vi } from 'vitest';
import { CUSTOM_TARGET, FULL_NAME_TARGET } from '@/google-sheets/sheet-rows';
import { AirtableSourcesService, parseExternal } from './airtable-sources.service';
import { AIRTABLE_IMPORT_REVIEW_REASON, airtableRowKey } from './airtable-records';
import type { AirtableField, AirtableRecord } from './types';

/**
 * Choosing a table, mapping its fields and importing it, with Prisma and
 * Airtable stubbed. What is pinned here is the behaviour that would lose or
 * mis-attribute leads: the mapping rules, and that an import goes through the
 * shared engine without approving anything by itself.
 */

const WHO = { organizationId: 'org-1', userId: 'user-1', sessionId: 'sess-1' };

const FIELDS: AirtableField[] = [
  { id: 'fldName', name: 'Name', type: 'singleLineText' },
  { id: 'fldEmail', name: 'Email', type: 'email' },
  { id: 'fldPhone', name: 'Phone', type: 'phoneNumber' },
  { id: 'fldBudget', name: 'Budget', type: 'currency' },
  { id: 'fldDone', name: 'Done', type: 'checkbox' },
  { id: 'fldCalc', name: 'Score', type: 'formula' },
];

const SOURCE = {
  id: 'src-1',
  name: 'Base › Leads',
  externalFormId: 'appBase1:tblLeads1',
  externalFormName: 'Base › Leads',
  integrationId: 'int-1',
  ingestStatus: 'NEEDS_MAPPING',
  mappingStatus: 'UNCONFIGURED',
  mappingVersion: 0,
  defaultConsentStatus: 'pending',
  syncNextAt: null,
  syncLockedAt: null,
  remoteSyncedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  remoteErrorCode: null,
  remoteErrorMessage: null,
  createdAt: new Date(),
};

function setup(over: { source?: Record<string, unknown>; records?: AirtableRecord[]; mappings?: Record<string, unknown>[]; holdGranted?: boolean; fields?: AirtableField[] } = {}) {
  const source = { ...SOURCE, ...over.source };
  const mappingRows: Record<string, unknown>[] = over.mappings ?? [];
  const fieldRows: Record<string, unknown>[] = [];
  const imported: { rows: unknown[]; reason: string; approve: unknown }[] = [];

  const prisma = {
    leadSource: {
      findFirst: vi.fn(async () => source),
      findMany: vi.fn(async () => [source]),
      create: vi.fn(async () => ({ id: 'src-1' })),
      updateMany: vi.fn(async ({ data }: any) => {
        Object.assign(source, data);
        return { count: 1 };
      }),
    },
    leadSourceField: {
      findMany: vi.fn(async () => fieldRows.map((f, i) => ({ id: `f${i}`, fieldKey: f.fieldKey, label: f.label, fieldType: f.fieldType }))),
      create: vi.fn(async ({ data }: any) => {
        fieldRows.push(data);
        return data;
      }),
      createMany: vi.fn(async ({ data }: any) => {
        fieldRows.push(...data);
        return { count: data.length };
      }),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    leadSourceFieldMapping: {
      findMany: vi.fn(async () => mappingRows),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: any) => {
        mappingRows.length = 0;
        mappingRows.push(...data.map((d: any) => ({ sourceFieldKey: d.sourceFieldKey, targetField: d.targetField, transform: d.transform })));
        return { count: data.length };
      }),
    },
    sheetImportRow: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 5 })) },
    lead: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
    integration: { findFirst: vi.fn(async () => ({ status: 'active' })) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const client = {
    baseSchema: vi.fn(async () => [{ id: 'tblLeads1', name: 'Leads', fields: over.fields ?? FIELDS }]),
    listBases: vi.fn(async () => ({ bases: [{ id: 'appBase1', name: 'Base' }], offset: null })),
    listRecords: vi.fn(async () => ({ records: over.records ?? [], offset: null })),
  };
  const connections = {
    mustFind: vi.fn(async () => ({ id: 'int-1' })),
    withAccessToken: vi.fn(async (_o: string, _c: string, fn: (t: string) => unknown) => fn('tok')),
    toHttp: (e: unknown) => e,
    // A connection that may do everything, unless a test narrows it.
    permissions: vi.fn(async () => ({ readRecords: true, writeRecords: true, readSchema: true, writeSchema: true, manageWebhooks: true })),
  };
  const importer = {
    importRows: vi.fn(async (_o: string, _s: string, _c: string, rows: unknown[], _st: unknown, reason: string, approve: unknown) => {
      imported.push({ rows, reason, approve });
    }),
  };
  const sync = {
    nudge: vi.fn(),
    hold: vi.fn(async () => over.holdGranted ?? true),
    releaseHold: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async (_e: Record<string, unknown>) => undefined) };
  const config = { get: () => false };
  const service = new AirtableSourcesService(prisma as any, connections as any, client as any, importer as any, sync as any, audit as any, config as any);
  return { service, prisma, client, connections, importer, sync, audit, imported, source, mappingRows };
}

describe('packing a base and table into one lead source', () => {
  it('round-trips the Airtable ids, so a rename in Airtable changes nothing', () => {
    expect(parseExternal({ externalFormId: 'appBase1:tblLeads1' })).toEqual({ baseId: 'appBase1', tableId: 'tblLeads1' });
    expect(parseExternal({ externalFormId: null })).toEqual({ baseId: '', tableId: '' });
  });
});

describe('saving a field mapping', () => {
  const save = (s: ReturnType<typeof setup>, columns: { fieldKey: string; target: string }[]) =>
    s.service.saveMapping(WHO, 'src-1', { columns } as never);

  it('stores the mapping keyed by Airtable field id, not by field name', async () => {
    const s = setup();

    await save(s, [
      { fieldKey: 'fldName', target: FULL_NAME_TARGET },
      { fieldKey: 'fldEmail', target: 'email' },
      { fieldKey: 'fldPhone', target: 'phone' },
    ]);

    expect(s.mappingRows.map((m) => m.sourceFieldKey)).toEqual(['fldName', 'fldName', 'fldEmail', 'fldPhone']);
    expect(s.source.mappingStatus).toBe('CONFIGURED');
  });

  it('refuses a mapping with no name, and one with no way to reach the person', async () => {
    await expect(save(setup(), [{ fieldKey: 'fldEmail', target: 'email' }])).rejects.toMatchObject({
      response: { error: { details: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('name') })]) } },
    });
    await expect(save(setup(), [{ fieldKey: 'fldName', target: FULL_NAME_TARGET }])).rejects.toMatchObject({
      response: { error: { details: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('phone or email') })]) } },
    });
  });

  it('refuses an incompatible field type rather than importing nonsense', async () => {
    // A checkbox cannot be a phone number.
    await expect(
      save(setup(), [
        { fieldKey: 'fldName', target: FULL_NAME_TARGET },
        { fieldKey: 'fldDone', target: 'phone' },
      ]),
    ).rejects.toMatchObject({ response: { error: { details: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('checkbox') })]) } } });
  });

  it('refuses a field that is no longer in the table', async () => {
    await expect(
      save(setup(), [
        { fieldKey: 'fldName', target: FULL_NAME_TARGET },
        { fieldKey: 'fldGone', target: 'email' },
      ]),
    ).rejects.toMatchObject({ response: { error: { details: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('no longer') })]) } } });
  });

  it('refuses two Airtable fields filling the same lead field', async () => {
    await expect(
      save(setup(), [
        { fieldKey: 'fldName', target: FULL_NAME_TARGET },
        { fieldKey: 'fldEmail', target: 'email' },
        { fieldKey: 'fldCalc', target: 'email' },
      ]),
    ).rejects.toMatchObject({ response: { error: { details: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('already filled') })]) } } });
  });

  it('records the Airtable table’s fields by id, so a renamed field keeps its mapping', async () => {
    const s = setup();
    await save(s, [
      { fieldKey: 'fldName', target: FULL_NAME_TARGET },
      { fieldKey: 'fldEmail', target: 'email' },
      { fieldKey: 'fldPhone', target: 'phone' },
    ]);

    const created = (s.prisma.leadSourceField.createMany.mock.calls as any[]).flatMap((c) => c[0].data);
    expect(created.map((d) => d.fieldKey)).toEqual(FIELDS.map((f) => f.id));
    expect(created[0]).toMatchObject({ fieldKey: 'fldName', label: 'Name', fieldType: 'singleLineText' });
  });
});

describe('importing records', () => {
  const CONFIGURED = { mappingStatus: 'CONFIGURED' };
  const MAPPING = [
    { sourceFieldKey: 'fldName', targetField: 'first_name', transform: { kind: 'name_split', part: 'first' } },
    { sourceFieldKey: 'fldName', targetField: 'last_name', transform: { kind: 'name_split', part: 'last' } },
    { sourceFieldKey: 'fldEmail', targetField: 'email', transform: { kind: 'email' } },
  ];
  const records: AirtableRecord[] = [
    { id: 'recA', fields: { fldName: 'Ana Patel', fldEmail: 'ana@example.test' } },
    { id: 'recB', fields: { fldName: 'Ben Shah', fldEmail: 'ben@example.test' } },
    { id: 'recNoContact', fields: { fldName: 'No Contact' } },
  ];

  it('writes rows through the shared import engine, under the Airtable review reason', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });

    const result = await s.service.startImport(WHO, 'src-1', {} as never);

    expect(s.importer.importRows).toHaveBeenCalledOnce();
    const call = s.imported[0];
    expect(call.reason).toBe(AIRTABLE_IMPORT_REVIEW_REASON);
    // The unreachable record is skipped, not written.
    expect((call.rows as { externalId: string }[]).map((r) => r.externalId)).toEqual(['recA', 'recB']);
    expect(result).toMatchObject({ read: 3, skipped: 1 });
  });

  it('approves nothing on its own: without ticks the engine is given no approval rule', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });

    await s.service.startImport(WHO, 'src-1', {} as never);

    expect(s.imported[0].approve).toBeNull();
  });

  it('approves only the records the owner ticked, by Airtable record id', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });

    await s.service.startImport(WHO, 'src-1', { approveRecordIds: ['recB'] } as never);

    const approve = s.imported[0].approve as { rule: (r: { externalId?: string }) => boolean; by: { userId: string } };
    expect(approve.by).toEqual({ userId: 'user-1' });
    expect(approve.rule({ externalId: 'recB' })).toBe(true);
    expect(approve.rule({ externalId: 'recA' })).toBe(false);
    expect(approve.rule({})).toBe(false);
  });

  it('keys every imported row by its Airtable record id', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });
    await s.service.startImport(WHO, 'src-1', {} as never);
    expect((s.imported[0].rows as { key: string }[])[0].key).toBe(airtableRowKey('recA'));
  });

  it('refuses to import before a mapping is saved', async () => {
    const s = setup({ records, mappings: [] });
    await expect(s.service.startImport(WHO, 'src-1', {} as never)).rejects.toMatchObject({
      response: { error: { code: 'MAPPING_REQUIRED' } },
    });
    expect(s.importer.importRows).not.toHaveBeenCalled();
  });

  it('refuses to import when the Airtable connection is no longer active', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });
    s.prisma.integration.findFirst = vi.fn(async () => ({ status: 'invalid' }));

    await expect(s.service.startImport(WHO, 'src-1', {} as never)).rejects.toMatchObject({
      response: { error: { code: 'AIRTABLE_REAUTH_REQUIRED' } },
    });
    expect(s.importer.importRows).not.toHaveBeenCalled();
  });
});

describe('previewing a table', () => {
  it('shows each field with the lead fields it may fill, and writes nothing', async () => {
    const s = setup({ records: [{ id: 'recA', fields: { fldName: 'Ana', fldEmail: 'a@b.test' } }] });

    const preview = await s.service.preview('org-1', 'src-1');

    const phone = preview.fields.find((f) => f.id === 'fldPhone')!;
    expect(phone.allowedTargets).toContain('phone');
    const done = preview.fields.find((f) => f.id === 'fldDone')!;
    // A checkbox may only ever be carried as a custom field.
    expect(done.allowedTargets).toEqual([CUSTOM_TARGET]);
    const calc = preview.fields.find((f) => f.id === 'fldCalc')!;
    expect(calc.readOnly).toBe(true);
    expect(s.importer.importRows).not.toHaveBeenCalled();
  });

  it('suggests no mapping at all: nothing is mapped that the owner did not map', async () => {
    const s = setup({ records: [{ id: 'recA', fields: { fldName: 'Ana', fldEmail: 'a@b.test' } }] });
    const preview = await s.service.preview('org-1', 'src-1');
    expect(preview.mapping).toEqual([]);
  });
});

describe('one import at a time', () => {
  const CONFIGURED = { mappingStatus: 'CONFIGURED' };
  const MAPPING = [
    { sourceFieldKey: 'fldName', targetField: 'first_name', transform: { kind: 'name_split', part: 'first' } },
    { sourceFieldKey: 'fldEmail', targetField: 'email', transform: { kind: 'email' } },
  ];
  const records: AirtableRecord[] = [{ id: 'recA', fields: { fldName: 'Ana Patel', fldEmail: 'ana@example.test' } }];

  it('refuses when the table is already being imported', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING, holdGranted: false });

    // A second click, or a browser retrying a request it thinks timed out, must
    // not run the whole import again alongside the first.
    await expect(s.service.startImport(WHO, 'src-1', {} as never)).rejects.toMatchObject({
      response: { error: { code: 'AIRTABLE_IMPORT_RUNNING' } },
    });
    expect(s.importer.importRows).not.toHaveBeenCalled();
  });

  it('gives the hold back even when the import fails', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });
    s.importer.importRows.mockRejectedValueOnce(new Error('engine fell over'));

    await expect(s.service.startImport(WHO, 'src-1', {} as never)).rejects.toThrow();

    // Otherwise the table stays locked until the lease ages out.
    expect(s.sync.releaseHold).toHaveBeenCalledOnce();
  });

  it('hands the table to the worker once the first run is done', async () => {
    const s = setup({ source: CONFIGURED, records, mappings: MAPPING });

    await s.service.startImport(WHO, 'src-1', {} as never);

    // Without a due time the worker has no reason to look at this table again,
    // so an import-only source would take its first load and never notice
    // anything added in Airtable afterwards.
    const update = s.prisma.leadSource.updateMany.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.ingestStatus === 'ACTIVE');
    expect(update.syncNextAt).toBeInstanceOf(Date);
    expect(s.sync.nudge).toHaveBeenCalled();
  });
});

describe('a table that carries phone numbers', () => {
  const save = (s: ReturnType<typeof setup>, columns: { fieldKey: string; target: string }[]) =>
    s.service.saveMapping(WHO, 'src-1', { columns } as never);

  it('refuses a mapping that leaves the phone column out', async () => {
    // Email alone satisfies "phone or email", and that is exactly the mistake:
    // EstatePulse qualifies a lead by calling and texting it, so every lead
    // imported this way would arrive and be held for having no number.
    await expect(
      save(setup(), [
        { fieldKey: 'fldName', target: FULL_NAME_TARGET },
        { fieldKey: 'fldEmail', target: 'email' },
      ]),
    ).rejects.toMatchObject({
      response: {
        error: {
          details: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('"Phone" to Phone') })]),
        },
      },
    });
  });

  it('accepts it once the phone column is mapped', async () => {
    const s = setup();

    await save(s, [
      { fieldKey: 'fldName', target: FULL_NAME_TARGET },
      { fieldKey: 'fldPhone', target: 'phone' },
    ]);

    expect(s.mappingRows.some((m) => m.targetField === 'phone')).toBe(true);
  });

  it('asks only for "phone or email" when the table has no phone column', async () => {
    // Nothing in this table is typed as a phone number, so requiring one would
    // be asking the owner for something that is not there.
    const s = setup({ fields: FIELDS.filter((f) => f.type !== 'phoneNumber') });

    await save(s, [
      { fieldKey: 'fldName', target: FULL_NAME_TARGET },
      { fieldKey: 'fldEmail', target: 'email' },
    ]);

    expect(s.mappingRows.some((m) => m.targetField === 'email')).toBe(true);
  });
});

describe('changing what gets reported back', () => {
  const configured = (writeBack: unknown[]) => ({
    syncConfig: { direction: 'two_way', exportScope: 'this_table', writeBack },
  });

  it('queues every record again, because the columns changed even though no lead did', async () => {
    const s = setup({ source: configured([]) });

    await s.service.setSyncConfig(WHO, 'src-1', {
      direction: 'two_way',
      writeBack: [{ key: 'ep_status', fieldId: 'fldStatus' }],
    } as never);

    // The push picks its work with "has this lead changed since we last wrote
    // it", which cannot see a new column. Without clearing the fingerprint the
    // column is created and then never filled.
    const queued = s.prisma.sheetImportRow.updateMany.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.pushedHash === null);
    expect(queued).toBeTruthy();
  });

  it('leaves them alone when only the direction changed', async () => {
    const wb = [{ key: 'ep_status', fieldId: 'fldStatus' }];
    const s = setup({ source: configured(wb) });

    await s.service.setSyncConfig(WHO, 'src-1', { direction: 'two_way', writeBack: wb } as never);

    const requeued = s.prisma.sheetImportRow.updateMany.mock.calls
      .map((c: any) => c[0].data)
      .some((d: any) => d.pushedHash === null);
    expect(requeued).toBe(false);
  });
});

describe('the table list', () => {
  it('says which way each table syncs, so the card need not open it to find out', async () => {
    const s = setup({
      source: { syncConfig: { direction: 'two_way', exportScope: 'this_table', writeBack: [] } },
    });

    const [row] = await s.service.list(WHO.organizationId);

    expect(row.direction).toBe('two_way');
  });

  it('falls back to import for a table that was never configured', async () => {
    const s = setup({ source: { syncConfig: null } });

    const [row] = await s.service.list(WHO.organizationId);

    expect(row.direction).toBe('import');
  });
});

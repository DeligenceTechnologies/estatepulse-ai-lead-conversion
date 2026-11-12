import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoogleApiError } from './google.client';
import { SheetRowEditService, editableTargets, rowIsEditable } from './sheet-row-edit.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const WHO = { organizationId: 'org-1', userId: 'user-1', sessionId: 's-1' };

// Header row and the lead's row (row 5 of the sheet): ID, Name, Phone, Email.
const HEADER = ['Lead ID', 'Name', 'Phone', 'Email'];
const ROW = ['L-42', 'Ana Silva', '+14155550100', 'ana@example.test'];
const SPLIT = (part: string) => ({ kind: 'name_split', part });
const MAPPINGS = [
  { sourceFieldKey: 'name', targetField: 'first_name', transform: SPLIT('first') },
  { sourceFieldKey: 'name', targetField: 'last_name', transform: SPLIT('last') },
  { sourceFieldKey: 'phone', targetField: 'phone', transform: { kind: 'phone_e164' } },
  { sourceFieldKey: 'email', targetField: 'email', transform: { kind: 'email' } },
];

function setup(over: { row?: Record<string, unknown>; source?: Record<string, unknown>; sheetRow?: string[]; mappings?: unknown[] } = {}) {
  const tracked = {
    id: 'row-1',
    rowKey: sha('id\u0000L-42'),
    rowNumber: 5,
    reviewState: 'pending',
    missingSince: null,
    leadId: 'lead-1',
    leadSourceId: 'src-1',
    lead: { firstName: 'Ana', lastName: 'Silva', phone: '+14155550100', email: 'ana@example.test' },
    leadSource: { provider: 'GOOGLE_SHEETS', connectionMethod: 'SYNC', integrationId: 'int-1', externalFormId: 'sheet-abc:7', syncRowKeyField: 'lead id', ...over.source },
    ...over.row,
  };
  const prisma = {
    sheetImportRow: { findFirst: vi.fn(async () => tracked) },
    leadSourceFieldMapping: { findMany: vi.fn(async () => over.mappings ?? MAPPINGS) },
  };
  const google = {
    readGrid: vi.fn(async (_t: string, _s: string, _id: number, _rows: number, _cols: number, start: number) => [start === 0 ? HEADER : (over.sheetRow ?? ROW)]),
    writeCells: vi.fn(async () => undefined),
  };
  const connections = { withAccessToken: vi.fn(async (_o: string, _i: string, fn: (t: string) => unknown) => fn('tok')) };
  const importer = { syncSourceNow: vi.fn(async () => ({ ran: true })) };
  const audit = { record: vi.fn(async (_entry: unknown) => undefined) };
  const service = new SheetRowEditService(prisma as any, connections as any, google as any, importer as any, audit as any);
  return { service, google, importer, audit, edit: (body: Record<string, string>) => service.edit(WHO, 'row-1', body as any) };
}

describe('editing a sheet row from Import Review', () => {
  it('writes only the changed cell, as typed text, into the row the lead came from, then re-reads the sheet', async () => {
    const s = setup();
    await expect(s.edit({ phone: '+1 (415) 555-0199' })).resolves.toEqual({ written: ['phone'], synced: true });
    expect(s.google.writeCells).toHaveBeenCalledWith('tok', 'sheet-abc', 7, [{ row: 4, col: 2, value: '+14155550199' }]);
    expect(s.importer.syncSourceNow).toHaveBeenCalledWith('org-1', 'src-1');
    expect(s.audit.record.mock.calls[0][0]).toMatchObject({ action: 'sheet.row_edited', entityId: 'lead-1', payload: { fields: ['phone'], cellsWritten: 1 } });
  });

  it('a "Full name" column is written whole, from both names', async () => {
    const s = setup();
    await s.edit({ lastName: 'Silva Costa' });
    expect(s.google.writeCells).toHaveBeenCalledWith('tok', 'sheet-abc', 7, [{ row: 4, col: 1, value: 'Ana Silva Costa' }]);
  });

  it('refuses when the row moved since the last sync, and syncs so the next try finds it', async () => {
    const s = setup({ sheetRow: ['L-77', 'Bo Lee', '+14155550111', 'bo@example.test'] });
    await expect(s.edit({ phone: '+14155550199' })).rejects.toThrow(/row moved/);
    expect(s.google.writeCells).not.toHaveBeenCalled();
    expect(s.importer.syncSourceNow).toHaveBeenCalled();
  });

  it.each([
    ['an approved row', { row: { reviewState: 'approved' } }],
    ['a row gone from the sheet', { row: { missingSince: new Date() } }],
    ['a sheet without an ID column', { source: { syncRowKeyField: null } }],
    ['a HubSpot contact', { source: { provider: 'HUBSPOT' } }],
  ])('refuses %s', async (_what, over) => {
    const s = setup(over as any);
    await expect(s.edit({ phone: '+14155550199' })).rejects.toThrow(/Only a Google Sheets row/);
    expect(s.google.writeCells).not.toHaveBeenCalled();
  });

  it('refuses a field the sheet has no column for, and values a person must fix', async () => {
    await expect(setup().edit({ timezone: 'America/Chicago' })).rejects.toThrow(/no column for timezone/);
    await expect(setup().edit({ phone: '4155550199' })).rejects.toThrow(/country code/);
    await expect(setup().edit({ email: 'not-an-email' })).rejects.toThrow(/email address/);
    await expect(setup().edit({ phone: '', email: '' })).rejects.toThrow(/phone number or an email/);
  });

  it("says plainly when the Google account may only view the sheet", async () => {
    const s = setup();
    s.google.writeCells.mockRejectedValue(new GoogleApiError('DENIED', 'The caller does not have permission', 403));
    await expect(s.edit({ phone: '+14155550199' })).rejects.toThrow(/can’t edit this sheet/);
  });

  it('lists which fields a sheet can take back, and which rows qualify', () => {
    expect(editableTargets([...MAPPINGS, { targetField: 'timezone' }, { targetField: 'location' }])).toEqual(['first_name', 'last_name', 'phone', 'email', 'timezone']);
    const ok = { reviewState: 'pending', missingSince: null, leadId: 'l', leadSource: { provider: 'GOOGLE_SHEETS', connectionMethod: 'SYNC', syncRowKeyField: 'id' } };
    expect(rowIsEditable(ok as any)).toBe(true);
    expect(rowIsEditable({ ...ok, leadSource: { ...ok.leadSource, syncRowKeyField: null } } as any)).toBe(false);
  });
});

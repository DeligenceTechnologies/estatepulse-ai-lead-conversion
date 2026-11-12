import { describe, expect, it, vi } from 'vitest';
import { CRM_PROVIDER_LABELS, crmRowIsEditable, crmRowKey } from './crm-records';
import { CrmRowEditService } from './crm-row-edit.service';
import { CrmApiError } from './types';

const WHO = { organizationId: 'org-1', userId: 'user-1', sessionId: 's-1' };
const adapter = { provider: 'HUBSPOT', label: CRM_PROVIDER_LABELS.HUBSPOT, updateContact: vi.fn() };

function setup(over: { row?: Record<string, unknown>; lead?: Record<string, unknown>; source?: Record<string, unknown> } = {}) {
  adapter.updateContact = vi.fn(async () => ({}));
  const tracked = {
    id: 'row-1',
    rowKey: crmRowKey('HUBSPOT', 'contact', '901'),
    reviewState: 'pending',
    missingSince: null,
    leadId: 'lead-1',
    leadSourceId: 'src-1',
    lead: { externalLeadId: '901', phone: '+14155550100', email: 'ana@example.test', ...over.lead },
    leadSource: { provider: 'HUBSPOT', connectionMethod: 'SYNC', integrationId: 'int-1', ...over.source },
    ...over.row,
  };
  const prisma = {
    sheetImportRow: { findFirst: vi.fn(async () => tracked) },
    ingestEvent: { create: vi.fn(async (_args: unknown) => ({})) },
  };
  // Like the real one: a REAUTH reaching it would park the connection.
  const parked = vi.fn();
  const connections = {
    withAccessToken: vi.fn(async (_a: unknown, _o: string, _c: string, fn: (t: string) => unknown) => {
      try {
        return await fn('tok');
      } catch (e) {
        if (e instanceof CrmApiError && e.kind === 'REAUTH') parked();
        throw e;
      }
    }),
  };
  const sync = { nudge: vi.fn() };
  const audit = { record: vi.fn(async (_entry: unknown) => undefined) };
  const service = new CrmRowEditService(prisma as any, connections as any, sync as any, audit as any);
  return { prisma, sync, audit, parked, edit: (body: Record<string, string>) => service.edit(WHO, adapter as any, 'row-1', body) };
}

describe('editing a HubSpot contact from Import Review', () => {
  it('writes only what was sent to the contact, then queues the re-read a webhook would', async () => {
    const s = setup();
    await expect(s.edit({ phone: '+1 (415) 555-0199', firstName: ' Ana ' })).resolves.toEqual({ written: ['first_name', 'phone'], queued: true });
    expect(adapter.updateContact).toHaveBeenCalledWith('tok', '901', { firstName: 'Ana', phone: '+14155550199' });
    const event = (s.prisma.ingestEvent.create.mock.calls[0][0] as any).data;
    expect(event).toMatchObject({ leadSourceId: 'src-1', provider: 'HUBSPOT', queueState: 'PENDING', payload: { contactIds: ['901'] } });
    expect(s.sync.nudge).toHaveBeenCalledOnce();
    expect(s.audit.record.mock.calls[0][0]).toMatchObject({ action: 'crm.contact_edited', entityId: 'lead-1', payload: { fields: ['first_name', 'phone'] } });
  });

  it.each([
    ['an approved row', { row: { reviewState: 'approved' } }],
    ['a contact gone from HubSpot', { row: { missingSince: new Date() } }],
    ['a lead carrying another source’s id', { lead: { externalLeadId: 'sheet-77' } }],
    ['a Google Sheets row', { source: { provider: 'GOOGLE_SHEETS' } }],
  ])('refuses %s, and writes nothing', async (_what, over) => {
    const s = setup(over as any);
    await expect(s.edit({ phone: '+14155550199' })).rejects.toThrow(/Only a HubSpot contact/);
    expect(adapter.updateContact).not.toHaveBeenCalled();
    expect(s.prisma.ingestEvent.create).not.toHaveBeenCalled();
  });

  it('refuses values a person must fix, and the time zone, before calling HubSpot', async () => {
    await expect(setup().edit({ phone: '4155550199' })).rejects.toThrow(/country code/);
    await expect(setup().edit({ email: 'nope' })).rejects.toThrow(/email address/);
    await expect(setup().edit({ timezone: 'America/Chicago' })).rejects.toThrow(/kept in EstatePulse/);
    expect(adapter.updateContact).not.toHaveBeenCalled();
  });

  it('a missing write scope asks for a reconnect without parking a connection that still syncs', async () => {
    const s = setup();
    adapter.updateContact.mockRejectedValue(new CrmApiError('REAUTH', 'MISSING_SCOPES: crm.objects.contacts.write', 403));
    await expect(s.edit({ phone: '+14155550199' })).rejects.toThrow(/Reconnect HubSpot to allow edits/);
    expect(s.parked).not.toHaveBeenCalled();
    expect(s.prisma.ingestEvent.create).not.toHaveBeenCalled();
  });

  it('says plainly when the email belongs to another contact, or the contact is gone', async () => {
    const taken = setup();
    adapter.updateContact.mockRejectedValue(new CrmApiError('CONFLICT', 'Contact already exists', 409));
    await expect(taken.edit({ email: 'bo@example.test' })).rejects.toThrow(/already has this email/);
    const gone = setup();
    adapter.updateContact.mockRejectedValue(new CrmApiError('NOT_FOUND', 'not found', 404));
    await expect(gone.edit({ email: 'bo@example.test' })).rejects.toThrow(/no longer in HubSpot/);
  });

  it('a row is editable only when its lead carries the contact id it was keyed by', () => {
    const row = {
      rowKey: crmRowKey('HUBSPOT', 'contact', '901'),
      reviewState: 'pending',
      missingSince: null,
      lead: { externalLeadId: '901' },
      leadSource: { provider: 'HUBSPOT', connectionMethod: 'SYNC' },
    };
    expect(crmRowIsEditable(row as any)).toBe(true);
    expect(crmRowIsEditable({ ...row, lead: { externalLeadId: '902' } } as any)).toBe(false);
    expect(crmRowIsEditable({ ...row, reviewState: 'rejected' } as any)).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { LeadStateService } from '@/lead/lead-state.service';
import { OptOutService } from './opt-out.service';

const PHONE = '+12899174129';

function setup(rows: { id: string; status: string; dncStatus?: boolean; normalizedPhone?: string | null }[]) {
  const leads = rows.map((r) => ({ orgId: 'org-1', dncStatus: false, normalizedPhone: PHONE as string | null, ...r }));
  const byId = (id: string) => leads.find((l) => l.id === id);
  const suppressed = new Map<string, { source: string; reason: string }>();
  const prisma = {
    lead: {
      findUnique: vi.fn(async ({ where }: any) => {
        const found = byId(where.id);
        return found ? { ...found } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        leads
          .filter((l) => (where.OR ?? [{ normalizedPhone: where.normalizedPhone }]).some((c: any) => (c.id ? l.id === c.id : l.normalizedPhone === c.normalizedPhone)))
          .filter((l) => where.dncStatus === undefined || l.dncStatus === where.dncStatus)
          .map((l) => ({ id: l.id })),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const found = byId(where.id);
        if (found && typeof data.dncStatus === 'boolean') found.dncStatus = data.dncStatus;
        return {};
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = byId(where.id);
        if (found && data?.status) found.status = data.status;
        return { count: found ? 1 : 0 };
      }),
    },
    leadEvent: { create: vi.fn(async () => ({})) },
    contactSuppression: {
      upsert: vi.fn(async ({ create }: any) => {
        if (!suppressed.has(create.normalizedPhone)) suppressed.set(create.normalizedPhone, create);
      }),
      deleteMany: vi.fn(async ({ where }: any) => suppressed.delete(where.normalizedPhone)),
    },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
  };
  const followup = { stopForLead: vi.fn(async () => 1) };
  const service = new OptOutService(prisma as any, new LeadStateService(prisma as any), followup as any);
  const events = () => prisma.leadEvent.create.mock.calls.map((c: any[]) => ({ lead: c[0].data.leadId, type: c[0].data.type, reason: c[0].data.reason, callId: c[0].data.callId }));
  return { service, prisma, leads, suppressed, followup, events };
}

const CALL = { source: 'call', reason: 'Asked not to be contacted again', channel: 'voice' as const, callId: 'call-1' };

describe('OptOutService.optOut', () => {
  it("reads the number from the lead that asked, and opts out every lead with it", async () => {
    const s = setup([
      { id: 'lead-1', status: 'engaged' },
      { id: 'lead-2', status: 'contacting' },
      { id: 'other', status: 'contacting', normalizedPhone: '+15125550188' },
    ]);
    expect(await s.service.optOut('org-1', { leadId: 'lead-1' }, CALL)).toEqual(['lead-1', 'lead-2']);
    expect(s.suppressed.get(PHONE)).toMatchObject({ source: 'call', reason: CALL.reason });
    expect(s.leads.map((l) => [l.id, l.dncStatus, l.status])).toEqual([
      ['lead-1', true, 'not_interested'],
      ['lead-2', true, 'not_interested'],
      ['other', false, 'contacting'],
    ]);
    expect(s.followup.stopForLead).toHaveBeenCalledTimes(2);
  });

  it("logs the call on the lead that asked, and says why on the others", async () => {
    const s = setup([{ id: 'lead-1', status: 'engaged' }, { id: 'lead-2', status: 'contacting' }]);
    await s.service.optOut('org-1', { leadId: 'lead-1' }, CALL);
    const optedOut = s.events().filter((e) => e.type === 'opted_out');
    expect(optedOut).toEqual([
      { lead: 'lead-1', type: 'opted_out', reason: CALL.reason, callId: 'call-1' },
      { lead: 'lead-2', type: 'opted_out', reason: `${CALL.reason} (said by another lead with this phone)`, callId: null },
    ]);
  });

  it('keeps a booked lead booked, and do-not-contact all the same', async () => {
    const s = setup([{ id: 'lead-1', status: 'appointment_booked' }]);
    await s.service.optOut('org-1', { leadId: 'lead-1' }, CALL);
    expect(s.leads[0]).toMatchObject({ status: 'appointment_booked', dncStatus: true });
  });

  it('opts out a lead with no phone on its own, with nothing to suppress', async () => {
    const s = setup([{ id: 'lead-1', status: 'engaged', normalizedPhone: null }]);
    expect(await s.service.optOut('org-1', { leadId: 'lead-1' }, CALL)).toEqual(['lead-1']);
    expect(s.prisma.contactSuppression.upsert).not.toHaveBeenCalled();
  });

  it('suppresses a number no lead has', async () => {
    const s = setup([]);
    expect(await s.service.optOut('org-1', { phone: PHONE }, { source: 'sms_reply', reason: 'STOP', channel: 'sms' })).toEqual([]);
    expect(s.suppressed.has(PHONE)).toBe(true);
  });

  it('keeps the first reason when the number opts out again', async () => {
    const s = setup([{ id: 'lead-1', status: 'engaged' }]);
    await s.service.optOut('org-1', { leadId: 'lead-1' }, CALL);
    await s.service.optOut('org-1', { phone: PHONE }, { source: 'sms_reply', reason: 'STOP', channel: 'sms' });
    expect(s.suppressed.get(PHONE)).toMatchObject({ source: 'call' });
  });
});

describe('OptOutService.optIn', () => {
  it('lifts the number and every opted-out lead with it, back to follow-up', async () => {
    const s = setup([
      { id: 'lead-1', status: 'not_interested', dncStatus: true },
      { id: 'lead-2', status: 'appointment_booked', dncStatus: true },
    ]);
    s.suppressed.set(PHONE, { source: 'sms_reply', reason: 'STOP' });
    expect(await s.service.optIn('org-1', PHONE, 'START')).toEqual(['lead-1', 'lead-2']);
    expect(s.suppressed.has(PHONE)).toBe(false);
    expect(s.leads.map((l) => [l.status, l.dncStatus])).toEqual([
      ['follow_up', false],
      ['appointment_booked', false],
    ]);
    expect(s.events().filter((e) => e.type === 'opted_in')).toHaveLength(2);
  });
});

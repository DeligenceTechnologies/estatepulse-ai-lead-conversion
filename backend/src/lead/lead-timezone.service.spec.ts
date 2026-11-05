import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PERMISSIONS_KEY } from '@/role/decorators/require-permissions.decorator';
import { SetLeadTimezoneDto } from './dto/set-lead-timezone.dto';
import { LeadTimezoneService } from './lead-timezone.service';
import { LeadsController } from './leads.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';

/** Everyone with lead.read sees every lead; an assigned-only agent sees their own. */
const auth = (organizationId = ORG, userId = USER, permissions = ['lead.read']) => ({ organizationId, userId, permissions }) as unknown as AuthContext;
const assignedOnly = (userId = USER) => auth(ORG, userId, ['lead.update']);

/** A lead store of one organization: updateMany honours the whole where clause (org and assignee), as Postgres would. */
function harness(lead: { id: string; orgId: string; normalizedPhone: string | null; timezone: string | null; assignedToId?: string | null }) {
  const prisma = {
    lead: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; orgId: string; assignedToId?: string }; data: { timezone: string | null } }) => {
        if (where.id !== lead.id || where.orgId !== lead.orgId) return { count: 0 };
        if (where.assignedToId !== undefined && where.assignedToId !== (lead.assignedToId ?? null)) return { count: 0 };
        lead.timezone = data.timezone;
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ normalizedPhone: lead.normalizedPhone })),
    },
  };
  const state = { quietly: vi.fn() };
  const delayed = { call: { data: { leadId: lead.id }, promote: vi.fn() }, other: { data: { leadId: 'someone-else' }, promote: vi.fn() } };
  const calls = { name: 'call', getDelayed: vi.fn(async () => [delayed.call, delayed.other]) };
  const texts = { name: 'text', getDelayed: vi.fn(async () => []) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new LeadTimezoneService(prisma as any, state as any, calls as any, texts as any);
  return { service, prisma, state, delayed, lead };
}

describe('setting a lead time zone', () => {
  it('stores the zone, answers it as verified, logs the event and wakes the lead waiting call', async () => {
    const h = harness({ id: LEAD, orgId: ORG, normalizedPhone: '+17095550100', timezone: null });
    const zone = await h.service.set(auth(), LEAD, 'America/St_Johns');
    expect(h.lead.timezone).toBe('America/St_Johns');
    expect(zone).toMatchObject({ zone: 'America/St_Johns', status: 'verified', source: 'provided', jurisdiction: { country: 'CA', region: 'NL', status: 'estimated' } });
    expect(h.state.quietly).toHaveBeenCalledTimes(1);
    expect(h.state.quietly.mock.calls[0][0]).toMatchObject({ type: 'timezone_set', orgId: ORG, leadId: LEAD, actor: { type: 'user', id: USER } });
    expect(h.delayed.call.promote).toHaveBeenCalledTimes(1);
    expect(h.delayed.other.promote).not.toHaveBeenCalled();
  });

  it('null removes the override and the phone number decides again', async () => {
    const h = harness({ id: LEAD, orgId: ORG, normalizedPhone: '+16045550199', timezone: 'America/Toronto' });
    const zone = await h.service.set(auth(), LEAD, null);
    expect(h.lead.timezone).toBeNull();
    expect(zone).toMatchObject({ zone: 'America/Vancouver', status: 'inferred', source: 'phone' });
  });

  it('a zone the phone number does not sit in is recorded as a conflict', async () => {
    const h = harness({ id: LEAD, orgId: ORG, normalizedPhone: '+16045550199', timezone: null });
    const zone = await h.service.set(auth(), LEAD, 'America/Toronto');
    expect(zone.jurisdiction.status).toBe('conflict');
    expect(h.state.quietly.mock.calls.map((c) => c[0].type)).toEqual(['timezone_set', 'timezone_conflict']);
  });

  it('another organization cannot touch the lead: 404, nothing written, nothing woken', async () => {
    const h = harness({ id: LEAD, orgId: ORG, normalizedPhone: '+16045550199', timezone: null });
    await expect(h.service.set(auth(OTHER_ORG), LEAD, 'America/Toronto')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.lead.timezone).toBeNull();
    expect(h.state.quietly).not.toHaveBeenCalled();
    expect(h.delayed.call.promote).not.toHaveBeenCalled();
  });

  it('an agent who only sees their own leads cannot set the zone of anyone else in the organization', async () => {
    const h = harness({ id: LEAD, orgId: ORG, normalizedPhone: '+16045550199', timezone: null, assignedToId: OTHER_USER });
    await expect(h.service.set(assignedOnly(), LEAD, 'America/Toronto')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.lead.timezone).toBeNull();
    expect(h.delayed.call.promote).not.toHaveBeenCalled();
    // Their own lead is theirs to set.
    const mine = harness({ id: LEAD, orgId: ORG, normalizedPhone: '+16045550199', timezone: null, assignedToId: USER });
    await expect(mine.service.set(assignedOnly(), LEAD, 'America/Vancouver')).resolves.toMatchObject({ zone: 'America/Vancouver' });
  });

  it('a lead that does not exist is a 404 too', async () => {
    const h = harness({ id: LEAD, orgId: ORG, normalizedPhone: null, timezone: null });
    await expect(h.service.set(auth(), OTHER_ORG, 'America/Toronto')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the request body', () => {
  const check = async (body: object) => validate(plainToInstance(SetLeadTimezoneDto, body));

  it('takes an IANA zone', async () => {
    expect(await check({ timezone: 'America/Vancouver' })).toEqual([]);
  });

  it('takes null, which removes the override', async () => {
    expect(await check({ timezone: null })).toEqual([]);
  });

  it('rejects a name that is not a time zone', async () => {
    expect((await check({ timezone: 'Mars/Phobos' })).map((e) => e.property)).toEqual(['timezone']);
    expect((await check({ timezone: 42 })).map((e) => e.property)).toEqual(['timezone']);
  });

  it('rejects a body without the field: omitting it is not the same as null', async () => {
    expect((await check({})).map((e) => e.property)).toEqual(['timezone']);
  });
});

describe('the endpoint', () => {
  it('requires the lead.update permission', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, LeadsController.prototype.setTimezone)).toEqual(['lead.update']);
  });
});

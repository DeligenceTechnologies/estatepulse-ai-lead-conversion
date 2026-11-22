import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@/role/permissions';
import { AppointmentSnapshotService } from './appointment-snapshot.service';

const ORG = 'org-1';
const MEETING = '00000000-0000-7000-8000-0000000000aa';
const owner = { organizationId: ORG, userId: 'owner-1', permissions: [PERMISSIONS.LEAD_READ] } as any;
const agent = { organizationId: ORG, userId: 'agent-1', permissions: [] } as any;

const HOUR = 60 * 60 * 1000;
const ended = { id: 'appt-1', leadId: 'lead-1', status: 'scheduled', endsAt: new Date(Date.now() - HOUR), noShowAt: null as Date | null };

function setup(appointment: typeof ended | null = ended) {
  const tx = { leadAppointment: { update: vi.fn(async () => undefined) } };
  const prisma = {
    leadAppointment: { findFirst: vi.fn(async (_args: any) => appointment), findMany: vi.fn(async (_args: any) => []) },
    $transaction: vi.fn(async (run: (t: unknown) => unknown) => run(tx)),
    $executeRaw: vi.fn(async () => 1),
  };
  const state = { record: vi.fn(async () => undefined) };
  return { service: new AppointmentSnapshotService(prisma as any, state as any), prisma, tx, state };
}

/** The tagged-template SQL sent, with nested Prisma.sql fragments inlined. */
const sqlOf = (call: any[]) => {
  const [strings, ...values] = call as [string[], ...unknown[]];
  return strings.map((part, i) => part + ((values[i] as { sql?: string } | undefined)?.sql ?? (i < values.length ? '?' : ''))).join('');
};

describe('AppointmentSnapshotService.setNoShow', () => {
  it('marks an ended, scheduled appointment and logs it on the lead', async () => {
    const { service, tx, state } = setup();
    const result = await service.setNoShow(owner, MEETING, true);
    expect(result.noShowAt).not.toBeNull();
    expect(tx.leadAppointment.update).toHaveBeenCalledWith({
      where: { id: 'appt-1' },
      data: { noShowAt: expect.any(Date), noShowById: 'owner-1' },
    });
    expect(state.record).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-1', type: 'appointment_no_show', actor: { type: 'user', id: 'owner-1' } }),
      tx,
    );
  });

  it('takes a no-show back', async () => {
    const { service, tx, state } = setup({ ...ended, noShowAt: new Date() });
    expect(await service.setNoShow(owner, MEETING, false)).toEqual({ meetingId: MEETING, noShowAt: null });
    expect(tx.leadAppointment.update).toHaveBeenCalledWith({ where: { id: 'appt-1' }, data: { noShowAt: null, noShowById: null } });
    expect(state.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'appointment_no_show_cleared' }), tx);
  });

  it('refuses an appointment that has not ended, or is not scheduled', async () => {
    const future = setup({ ...ended, endsAt: new Date(Date.now() + HOUR) });
    await expect(future.service.setNoShow(owner, MEETING, true)).rejects.toThrow('not ended');
    const canceled = setup({ ...ended, status: 'canceled' });
    await expect(canceled.service.setNoShow(owner, MEETING, true)).rejects.toThrow('scheduled');
    expect(future.tx.leadAppointment.update).not.toHaveBeenCalled();
    expect(canceled.tx.leadAppointment.update).not.toHaveBeenCalled();
  });

  it('marking it again changes nothing and logs nothing', async () => {
    const { service, prisma, state } = setup({ ...ended, noShowAt: new Date('2026-11-01T00:00:00Z') });
    expect(await service.setNoShow(owner, MEETING, true)).toEqual({ meetingId: MEETING, noShowAt: '2026-11-01T00:00:00.000Z' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
  });

  it('an agent only reaches appointments of leads assigned to them; anything else is not found', async () => {
    const { service, prisma } = setup(null);
    await expect(service.setNoShow(agent, MEETING, true)).rejects.toThrow('No such appointment');
    expect(prisma.leadAppointment.findFirst.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      meetingId: MEETING,
      lead: { orgId: ORG, assignedToId: 'agent-1' },
    });
  });

  it('an owner reaches any lead of the organization', async () => {
    const { service, prisma } = setup();
    await service.setNoShow(owner, MEETING, true);
    expect(prisma.leadAppointment.findFirst.mock.calls[0][0].where.lead).toEqual({ orgId: ORG });
  });

  it('a malformed id never reaches the database', async () => {
    const { service, prisma } = setup();
    await expect(service.setNoShow(owner, 'nope', true)).rejects.toThrow('No such appointment');
    expect(prisma.leadAppointment.findFirst).not.toHaveBeenCalled();
  });
});

describe('AppointmentSnapshotService copies', () => {
  it('a re-sync refreshes the copy and keeps a no-show mark, unless the meeting moved', async () => {
    const { service, prisma } = setup();
    await service.syncConnection('00000000-0000-7000-8000-0000000000bb');
    const sql = sqlOf(prisma.$executeRaw.mock.calls[0]);
    expect(sql).toContain('ON CONFLICT (organization_id, provider, external_id) DO UPDATE');
    expect(sql).toContain('m.lead_id IS NOT NULL AND m.connection_id = ?::uuid');
    const update = sql.slice(sql.indexOf('DO UPDATE'));
    expect(update).toContain('status = EXCLUDED.status');
    expect(update).toContain('no_show_at = CASE WHEN lead_appointments.starts_at = EXCLUDED.starts_at THEN lead_appointments.no_show_at END');
    expect(update).toContain('no_show_by_id = CASE WHEN lead_appointments.starts_at = EXCLUDED.starts_at THEN lead_appointments.no_show_by_id END');
    expect(update).not.toContain('EXCLUDED.no_show');
    // A copy that already matches is not rewritten.
    expect(update).toContain('IS DISTINCT FROM');
  });

  it('a disconnect releases the upcoming appointments of that connection only', async () => {
    const { service, prisma } = setup();
    await service.releaseConnection('00000000-0000-7000-8000-0000000000bb');
    const sql = sqlOf(prisma.$executeRaw.mock.calls[0]);
    expect(sql).toContain("SET status = 'disconnected'");
    expect(sql).toContain('m.connection_id = ?::uuid');
    expect(sql).toContain('a.meeting_id = m.id');
    expect(sql).toContain("a.status IN ('scheduled', 'pending')");
    expect(sql).toContain('a.ends_at > now()');
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(service.releaseConnection('c')).resolves.toBeUndefined();
  });

  it('a failed copy never fails the sync that called it', async () => {
    const { service, prisma } = setup();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(service.syncConnection('c')).resolves.toBeUndefined();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(service.syncMeeting('c', 'ext')).resolves.toBeUndefined();
  });

  it('reads the no-show marks of the meetings asked for', async () => {
    const { service, prisma } = setup();
    const when = new Date('2026-11-02T00:00:00Z');
    prisma.leadAppointment.findMany.mockResolvedValueOnce([{ meetingId: 'm1', noShowAt: when }, { meetingId: 'm2', noShowAt: null }] as any);
    const marks = await service.noShows(ORG, ['m1', 'm2', 'm3']);
    expect(marks.get('m1')).toBe(when);
    expect(marks.get('m2')).toBeNull();
    expect(marks.has('m3')).toBe(false);
    expect(await service.noShows(ORG, [])).toEqual(new Map());
  });

  it('an appointment list still loads when the marks cannot be read', async () => {
    const { service, prisma } = setup();
    prisma.leadAppointment.findMany.mockRejectedValueOnce(new Error('relation "lead_appointments" does not exist'));
    expect(await service.noShows(ORG, ['m1'])).toEqual(new Map());
  });
});

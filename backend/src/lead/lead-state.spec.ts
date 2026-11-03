import { describe, expect, it, vi } from 'vitest';
import { canMove } from './lead-state';
import { LeadStateService } from './lead-state.service';

describe('canMove (automation rules)', () => {
  it('starts outreach only from new', () => {
    expect(canMove('new', 'contacting')).toBe(true);
    expect(canMove('follow_up', 'contacting')).toBe(false);
  });

  it('lets a reply re-open a lead that is not decided, parked or gone silent', () => {
    for (const from of ['new', 'contacting', 'follow_up', 'unresponsive'] as const) expect(canMove(from, 'engaged')).toBe(true);
    for (const from of ['appointment_booked', 'not_interested', 'invalid', 'closed'] as const) expect(canMove(from, 'engaged')).toBe(false);
  });

  it('lets a booking win over everything but a wrong number', () => {
    for (const from of ['new', 'engaged', 'follow_up', 'not_interested', 'unresponsive', 'closed'] as const) {
      expect(canMove(from, 'appointment_booked')).toBe(true);
    }
    expect(canMove('invalid', 'appointment_booked')).toBe(false);
  });

  it('never moves a booked lead back to follow-up or out, unless the move names the exception', () => {
    expect(canMove('appointment_booked', 'follow_up')).toBe(false);
    expect(canMove('appointment_booked', 'not_interested')).toBe(false);
    expect(canMove('appointment_booked', 'follow_up', { alsoFrom: ['appointment_booked'] })).toBe(true);
  });

  it('reaches unresponsive only from follow_up', () => {
    expect(canMove('follow_up', 'unresponsive')).toBe(true);
    expect(canMove('contacting', 'unresponsive')).toBe(false);
  });

  it('narrows with onlyFrom, and a person may make any move', () => {
    expect(canMove('interested', 'follow_up')).toBe(true);
    expect(canMove('interested', 'follow_up', { onlyFrom: ['new', 'contacting', 'engaged'] })).toBe(false);
    expect(canMove('closed', 'new', { manual: true })).toBe(true);
  });
});

function setup(status: string) {
  const lead = { orgId: 'org-1', status };
  let raced = 0;
  const prisma = {
    lead: {
      findUnique: vi.fn(async () => ({ ...lead })),
      findMany: vi.fn(),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (raced > 0) {
          raced -= 1;
          lead.status = 'engaged';
          return { count: 0 };
        }
        if (where.status !== lead.status) return { count: 0 };
        lead.status = data.status;
        return { count: 1 };
      }),
    },
    leadEvent: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
  };
  return { service: new LeadStateService(prisma as any), prisma, lead, race: () => (raced = 1) };
}

describe('LeadStateService.move', () => {
  it('moves, writes the extra fields, and logs who decided it and why', async () => {
    const s = setup('contacting');
    const result = await s.service.move('lead-1', 'follow_up', {
      source: 'strategy',
      reason: 'Strategy complete',
      data: { followUpReason: 'no_answer' },
    });
    expect(result).toEqual({ moved: true, from: 'contacting' });
    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', status: 'contacting' },
      data: { followUpReason: 'no_answer', status: 'follow_up' },
    });
    expect(s.prisma.leadEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        leadId: 'lead-1',
        type: 'status_changed',
        fromStatus: 'contacting',
        toStatus: 'follow_up',
        reason: 'Strategy complete',
        source: 'strategy',
        actorType: 'system',
      }),
    });
  });

  it('refuses a move the rules do not allow, and changes nothing', async () => {
    const s = setup('appointment_booked');
    expect(await s.service.move('lead-1', 'follow_up', { source: 'scoring' })).toEqual({ moved: false, from: 'appointment_booked' });
    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(s.prisma.leadEvent.create).not.toHaveBeenCalled();
  });

  it('re-reads and re-checks when another move changed the status first', async () => {
    const s = setup('contacting');
    s.race();
    // contacting → follow_up is allowed, but by the retry the lead is engaged, which is also allowed.
    const result = await s.service.move('lead-1', 'follow_up', { source: 'strategy' });
    expect(result).toEqual({ moved: true, from: 'engaged' });
    expect(s.prisma.lead.findUnique).toHaveBeenCalledTimes(2);
  });

  it('writes the fields but logs no move when the lead already has the status', async () => {
    const s = setup('follow_up');
    expect(await s.service.move('lead-1', 'follow_up', { source: 'scoring', data: { followUpReason: 'callback_requested' } })).toEqual({
      moved: true,
      from: 'follow_up',
    });
    expect(s.prisma.lead.updateMany).toHaveBeenCalledOnce();
    expect(s.prisma.leadEvent.create).not.toHaveBeenCalled();
  });

  it('reports a lead that does not exist', async () => {
    const s = setup('new');
    s.prisma.lead.findUnique.mockResolvedValue(null as any);
    expect(await s.service.move('missing', 'contacting', { source: 'strategy' })).toEqual({ moved: false, from: null });
  });
});

describe('LeadStateService.moveMany', () => {
  it('moves only the leads whose own status allows it, and logs each', async () => {
    const s = setup('new');
    s.prisma.lead.findMany
      .mockResolvedValueOnce([
        { id: 'a', orgId: 'org-1', status: 'contacting' },
        { id: 'b', orgId: 'org-1', status: 'appointment_booked' },
      ])
      .mockResolvedValueOnce([{ id: 'a' }]);
    s.prisma.lead.updateMany.mockResolvedValue({ count: 1 } as any);
    const moved = await s.service.moveMany(['a', 'b'], 'follow_up', { source: 'followup', onlyFrom: ['new', 'contacting', 'engaged'] });
    expect(moved).toEqual(['a']);
    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['a'] }, status: 'contacting' }, data: { status: 'follow_up' } });
    expect(s.prisma.leadEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ leadId: 'a', fromStatus: 'contacting', toStatus: 'follow_up' })],
    });
  });
});

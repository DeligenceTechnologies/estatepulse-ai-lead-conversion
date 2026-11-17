import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallTransferService, attemptIdOf, ringOutcome } from './call-transfer.service';

/**
 * The transfer's state machine against an in-memory store that applies conditional updates the
 * way the database does (only rows still matching `where` change), so racing events can be
 * replayed in any order.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
    }
    return (row[k] ?? null) === v;
  });
}

function table(rows: Row[]) {
  return {
    rows,
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    findFirst: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)).at(-1) ?? null),
    findMany: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where))),
    count: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)).length),
  };
}

const ORG = 'org-1';
const LEAD_CCID = 'lead-ccid';
const LEAD = { id: 'lead-1', firstName: 'Ana', lastName: 'Silva', location: 'Austin, TX', assignedToId: null as string | null };
const AGENTS = [
  { userId: 'agent-a', name: 'Amy Agent', phone: '+15125550101' },
  { userId: 'agent-b', name: 'Ben Broker', phone: '+15125550102' },
];
const XFER = { reason: 'hot_lead' as const, facts: { budget: '$600k', preApproved: true, showing: 'Saturday', location: 'Austin' } };

function setup(over: { agents?: typeof AGENTS; booking?: boolean; liveTransfer?: Row } = {}) {
  const transfers = table([]);
  const attempts = table([]);
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const withRelations = (t: Row) => ({
    ...t,
    lead: LEAD,
    attempts: attempts.rows.filter((a) => a.transferId === t.id).sort((x, y) => x.position - y.position),
  });

  const prisma: any = {
    callTransfer: {
      ...transfers,
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: id('xfer'), status: 'dialing', endedAt: null, connectedUserId: null, ...data };
        transfers.rows.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const t = transfers.rows.find((r) => r.id === where.id);
        return t ? withRelations(t) : null;
      }),
    },
    transferAttempt: {
      ...attempts,
      findUnique: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        const a = attempts.rows.find((r) => r.id === where.id);
        if (!a) return null;
        return select?.transfer ? { ...a, transfer: withRelations(transfers.rows.find((t) => t.id === a.transferId)!) } : a;
      }),
      findUniqueOrThrow: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        const a = attempts.rows.find((r) => r.id === where.id)!;
        return select?.transfer ? { ...a, transfer: withRelations(transfers.rows.find((t) => t.id === a.transferId)!) } : a;
      }),
    },
    call: { findUnique: vi.fn(async () => ({ providerCallId: LEAD_CCID, status: 'in_progress' })) },
    lead: { findUnique: vi.fn(async () => LEAD) },
    organizationSetting: {
      findUnique: vi.fn(async () => ({
        liveTransfer: { enabled: true, ...over.liveTransfer },
        inCallBooking: over.booking === false ? null : { tokenHash: 'h' },
      })),
    },
    calendarConnection: { findFirst: vi.fn(async () => ({ provider: 'calendly', status: 'active' })) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, transferId: string) => [{ status: transfers.rows.find((t) => t.id === transferId)?.status }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const queue = [...(over.agents ?? AGENTS)];
  const router = {
    claimNext: vi.fn(async (req: { transferId: string; position: number; exclude: string[] }) => {
      const next = queue.findIndex((a) => !req.exclude.includes(a.userId));
      if (next < 0) return null;
      const [agent] = queue.splice(next, 1);
      const attemptId = id('attempt');
      attempts.rows.push({ id: attemptId, orgId: ORG, transferId: req.transferId, userId: agent.userId, position: req.position, status: 'dialing', agentCallControlId: null, endedAt: null });
      return { attemptId, ...agent };
    }),
  };
  const commands: { ccid: string; name: string; body: Row }[] = [];
  const activity = {
    command: vi.fn(async (_org: string, ccid: string, name: string, body: Row = {}) => (commands.push({ ccid, name, body }), true)),
    pauseAssistant: vi.fn(async () => true),
    resumeAssistant: vi.fn(async () => true),
    voiceOf: vi.fn(async () => 'voice-1'),
  };
  const voice = { dialAgent: vi.fn(async (_o: string, to: string) => ({ call_control_id: `ccid-${to}` })) };
  const assignments = { assign: vi.fn(async () => ({})) };
  const audit = { record: vi.fn(async () => undefined) };
  const legs = { register: vi.fn() };
  const service = new CallTransferService(prisma, router as any, voice as any, activity as any, assignments as any, audit as any, legs as any);

  const attemptOf = (userId: string) => attempts.rows.find((a) => a.userId === userId)!;
  const leg = (userId: string) => ({ orgId: ORG, attemptId: attemptOf(userId).id });
  const agentCcid = (userId: string) => `ccid-${AGENTS.find((a) => a.userId === userId)!.phone}`;
  const event = (userId: string, type: string, payload: Row = {}) => service.onAgentLegEvent(leg(userId), agentCcid(userId), type, payload);

  return {
    service,
    prisma,
    router,
    activity,
    voice,
    assignments,
    commands,
    transfers: transfers.rows,
    attemptOf,
    event,
    agentCcid,
    start: () => service.start({ orgId: ORG, leadId: LEAD.id, callId: 'call-1' }, XFER.reason, XFER.facts),
  };
}

/** Lets the transfer's background steps (hold, ring) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

afterEach(() => vi.useRealTimers());

describe('live transfer of an AI call to an agent', () => {
  it('holds the lead, rings the first agent, and bridges them as soon as a person answers', async () => {
    const s = setup();
    await expect(s.start()).resolves.toMatchObject({ ok: true });
    await settle();
    expect(s.activity.pauseAssistant).toHaveBeenCalledWith(ORG, LEAD_CCID);
    expect(s.commands[0]).toMatchObject({ ccid: LEAD_CCID, name: 'speak' });
    expect(s.voice.dialAgent).toHaveBeenCalledWith(ORG, '+15125550101', { xfer: s.attemptOf('agent-a').id }, 20);

    await s.event('agent-a', 'call.answered');
    expect(s.attemptOf('agent-a').status).toBe('answered');
    expect(s.commands.some((c) => c.name === 'bridge')).toBe(false);

    await s.event('agent-a', 'call.machine.premium.detection.ended', { result: 'human_residence' });
    expect(s.commands.at(-1)).toEqual({ ccid: LEAD_CCID, name: 'bridge', body: { call_control_id: s.agentCcid('agent-a') } });
    expect(s.transfers[0]).toMatchObject({ status: 'connected', connectedUserId: 'agent-a' });
    expect(s.attemptOf('agent-a').status).toBe('accepted');
    expect(s.assignments.assign).toHaveBeenCalledWith(ORG, LEAD.id, 'agent-a', expect.objectContaining({ assignmentType: 'ai' }));
    expect(s.voice.dialAgent).toHaveBeenCalledTimes(1);
  });

  it('rings the second agent when the first does not answer, is busy or rejects', async () => {
    for (const cause of ['timeout', 'user_busy', 'call_rejected']) {
      const s = setup();
      await s.start();
      await settle();
      await s.event('agent-a', 'call.hangup', { hangup_cause: cause });
      expect(s.attemptOf('agent-a').status).toBe(ringOutcome(cause));
      expect(s.voice.dialAgent).toHaveBeenLastCalledWith(ORG, '+15125550102', { xfer: s.attemptOf('agent-b').id }, 20);
      expect(s.commands.filter((c) => c.ccid === LEAD_CCID && c.name === 'speak')).toHaveLength(2);
    }
  });

  it('never bridges the lead to a voicemail: it is hung up on and the next agent rung', async () => {
    for (const [type, payload] of [
      ['call.machine.premium.detection.ended', { result: 'machine' }],
      ['call.machine.premium.greeting.ended', {}],
    ] as const) {
      const machine = setup();
      await machine.start();
      await settle();
      await machine.event('agent-a', 'call.answered');
      await machine.event('agent-a', type, payload);
      expect(machine.attemptOf('agent-a').status).toBe('voicemail');
      expect(machine.commands).toContainEqual({ ccid: machine.agentCcid('agent-a'), name: 'hangup', body: {} });
      expect(machine.commands.some((c) => c.name === 'bridge')).toBe(false);
      expect(machine.voice.dialAgent).toHaveBeenCalledTimes(2);
    }
  });

  it('puts the lead through when no verdict comes in time, and moves on when the agent hangs up right after answering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow = setup();
    await slow.start();
    await settle();
    await slow.event('agent-a', 'call.answered');
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(slow.commands).toContainEqual({ ccid: LEAD_CCID, name: 'bridge', body: { call_control_id: slow.agentCcid('agent-a') } });
    expect(slow.attemptOf('agent-a').status).toBe('accepted');
    // The verdict arriving late changes nothing.
    await slow.event('agent-a', 'call.machine.premium.detection.ended', { result: 'human_residence' });
    expect(slow.commands.filter((c) => c.name === 'bridge')).toHaveLength(1);
    vi.useRealTimers();

    const hungUp = setup();
    await hungUp.start();
    await settle();
    await hungUp.event('agent-a', 'call.answered');
    await hungUp.event('agent-a', 'call.hangup', { hangup_cause: 'normal_clearing' });
    expect(hungUp.attemptOf('agent-a').status).toBe('declined');
    expect(hungUp.voice.dialAgent).toHaveBeenCalledTimes(2);
  });

  it('brings the assistant back to book a meeting when neither agent takes it', async () => {
    const s = setup();
    await s.start();
    await settle();
    await s.event('agent-a', 'call.hangup', { hangup_cause: 'timeout' });
    await s.event('agent-b', 'call.hangup', { hangup_cause: 'timeout' });
    expect(s.transfers[0]).toMatchObject({ status: 'no_agent', fallback: 'booking' });
    expect(s.router.claimNext).toHaveBeenCalledTimes(2);
    const [, , ccid, context, greeting] = s.activity.resumeAssistant.mock.calls[0] as unknown as string[];
    expect(ccid).toBe(LEAD_CCID);
    expect(context).toMatch(/check_availability and book_appointment/);
    expect(context).toMatch(/Only say a meeting is booked when book_appointment returns ok/);
    expect(greeting).toMatch(/book you a time/);
  });

  it('offers a callback instead, never a booking, when the calendar booking is not available', async () => {
    const s = setup({ booking: false });
    await s.start();
    await settle();
    await s.event('agent-a', 'call.hangup', { hangup_cause: 'timeout' });
    await s.event('agent-b', 'call.hangup', { hangup_cause: 'timeout' });
    expect(s.transfers[0]).toMatchObject({ fallback: 'callback' });
    const [, , , context] = s.activity.resumeAssistant.mock.calls[0] as unknown as string[];
    expect(context).toMatch(/schedule_callback/);
    expect(context).toMatch(/Never say a meeting is booked/);
  });

  it('when nobody is available at all, the assistant (still talking) is told to book instead, and nothing is rung', async () => {
    const s = setup({ agents: [] });
    await expect(s.start()).resolves.toMatchObject({ ok: false, reason: 'no_agent', say: expect.stringMatching(/book_appointment/) });
    await settle();
    expect(s.activity.pauseAssistant).not.toHaveBeenCalled();
    expect(s.voice.dialAgent).not.toHaveBeenCalled();
    expect(s.transfers[0]).toMatchObject({ status: 'no_agent' });
  });

  it('rings only the configured number of agents', async () => {
    const s = setup({ liveTransfer: { agentsPerTransfer: 1 } });
    await s.start();
    await settle();
    await s.event('agent-a', 'call.hangup', { hangup_cause: 'timeout' });
    expect(s.voice.dialAgent).toHaveBeenCalledTimes(1);
    expect(s.activity.resumeAssistant).toHaveBeenCalled();
  });

  it('stops ringing everyone when the lead hangs up, and rings nobody after', async () => {
    const s = setup();
    await s.start();
    await settle();
    await s.event('agent-a', 'call.answered');
    await s.service.onLeadHangup(LEAD_CCID);
    expect(s.transfers[0]).toMatchObject({ status: 'abandoned' });
    expect(s.attemptOf('agent-a').status).toBe('cancelled');
    expect(s.commands).toContainEqual({ ccid: s.agentCcid('agent-a'), name: 'hangup', body: {} });

    // The person verdict comes a moment later: too late, nothing is bridged and nobody else is rung.
    await s.event('agent-a', 'call.machine.premium.detection.ended', { result: 'human_residence' });
    await s.event('agent-a', 'call.hangup', { hangup_cause: 'normal_clearing' });
    expect(s.commands.some((c) => c.name === 'bridge')).toBe(false);
    expect(s.voice.dialAgent).toHaveBeenCalledTimes(1);
    expect(s.activity.resumeAssistant).not.toHaveBeenCalled();
  });

  it('an agent who picks up just as their ring time runs out is let go, and the next agent is rung only once', async () => {
    const s = setup();
    await s.start();
    await settle();
    // Our timer fires first…
    await (s.service as any).expire(s.attemptOf('agent-a').id);
    expect(s.attemptOf('agent-a').status).toBe('no_answer');
    expect(s.voice.dialAgent).toHaveBeenCalledTimes(2);
    // …then the pick-up and the hang-up arrive: neither rings anyone else.
    await s.event('agent-a', 'call.answered');
    expect(s.commands).toContainEqual({ ccid: s.agentCcid('agent-a'), name: 'hangup', body: {} });
    await s.event('agent-a', 'call.machine.premium.detection.ended', { result: 'human_residence' });
    expect(s.commands.some((c) => c.name === 'bridge')).toBe(false);
    await s.event('agent-a', 'call.hangup', { hangup_cause: 'normal_clearing' });
    expect(s.voice.dialAgent).toHaveBeenCalledTimes(2);
  });

  it('the same hang-up twice moves on once', async () => {
    const s = setup();
    await s.start();
    await settle();
    await Promise.all([s.event('agent-a', 'call.hangup', { hangup_cause: 'timeout' }), s.event('agent-a', 'call.hangup', { hangup_cause: 'timeout' })]);
    expect(s.voice.dialAgent).toHaveBeenCalledTimes(2);
  });

  it('a second transfer request on the same call is answered from the first', async () => {
    const s = setup();
    await s.start();
    await settle();
    await expect(s.start()).resolves.toMatchObject({ ok: true, say: expect.stringMatching(/already being connected/) });
    expect(s.router.claimNext).toHaveBeenCalledTimes(1);
  });

  it('refuses in a text chat, and when the trigger is switched off', async () => {
    const s = setup({ liveTransfer: { onHotLead: false } });
    await expect(s.service.start({ orgId: ORG, leadId: LEAD.id, callId: null }, 'hot_lead', {})).resolves.toMatchObject({ ok: false, reason: 'not_on_call' });
    await expect(s.start()).resolves.toMatchObject({ ok: false, reason: 'off' });
    expect(s.router.claimNext).not.toHaveBeenCalled();
  });

  it('leaves a lead another agent already holds with that agent', async () => {
    const s = setup();
    LEAD.assignedToId = 'someone-else';
    try {
      await s.start();
      await settle();
      expect(s.router.claimNext).toHaveBeenCalledWith(expect.objectContaining({ preferUserId: 'someone-else' }));
      await s.event('agent-a', 'call.answered');
      await s.event('agent-a', 'call.machine.premium.detection.ended', { result: 'human_business' });
      expect(s.commands.some((c) => c.name === 'bridge')).toBe(true);
      expect(s.assignments.assign).not.toHaveBeenCalled();
    } finally {
      LEAD.assignedToId = null;
    }
  });

  it('reads only its own agent legs from client_state', () => {
    const state = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    expect(attemptIdOf(state({ xfer: '0190a6f2-0000-7000-8000-000000000001' }))).toBe('0190a6f2-0000-7000-8000-000000000001');
    expect(attemptIdOf(state({ amd: true, context: 'x' }))).toBeNull();
    expect(attemptIdOf(undefined)).toBeUndefined();
  });
});

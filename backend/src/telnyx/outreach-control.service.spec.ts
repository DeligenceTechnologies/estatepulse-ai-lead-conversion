import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { OutreachControlService } from './outreach-control.service';

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-11-26T18:00:00Z');
const LATER = new Date('2026-11-27T16:00:00Z');
const EARLIER = new Date('2026-11-26T15:00:00Z');

const admin: AuthContext = { userId: 'admin-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read', 'lead.update'] };
const agent: AuthContext = { userId: 'agent-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };
const viewer: AuthContext = { userId: 'viewer-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read'] };

const baseLead = {
  id: LEAD,
  orgId: ORG,
  firstName: 'Maria',
  lastName: 'Lopez',
  status: 'contacting',
  dncStatus: false,
  consentStatus: 'granted',
  automationPaused: false,
  firstContactAt: new Date('2026-11-20T10:00:00Z') as Date | null,
  callbackAt: null as Date | null,
  textBackAt: null as Date | null,
  needsReview: false,
  reviewReasons: [] as string[],
  phone: '(512) 555-0101',
  phoneValid: true,
  timezone: 'America/Chicago',
  normalizedPhone: '+15125550101',
  updatedAt: NOW,
};

function setup(opts: { lead?: Partial<typeof baseLead> | null; running?: boolean; canResume?: boolean; resumed?: boolean; sequences?: object[]; lastControl?: object | null } = {}) {
  const lead = opts.lead === null ? null : { ...baseLead, ...opts.lead };
  const tx = { lead: { updateMany: vi.fn(async () => ({ count: 1 })) } };
  const prisma = {
    lead: { findFirst: vi.fn(async (args: any) => (args.select?.firstContactAt && Object.keys(args.select).length === 1 ? { firstContactAt: NOW } : lead)) },
    sequenceEnrollment: { findMany: vi.fn(async () => opts.sequences ?? []) },
    leadEvent: { findFirst: vi.fn(async () => opts.lastControl ?? null) },
    user: { findFirst: vi.fn(async () => ({ firstName: 'Sunny', lastName: 'Patel', email: 's@x.test' })) },
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Kolkata' })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const engine = {
    isRunning: vi.fn(() => opts.running ?? false),
    canResume: vi.fn(async () => opts.canResume ?? true),
    canReachLeads: vi.fn(async () => true),
    pauseStrategy: vi.fn(() => true),
    resume: vi.fn(async () => opts.resumed ?? true),
    enroll: vi.fn(async () => undefined),
  };
  const followup = {
    pauseForLead: vi.fn(async () => 1),
    resumeForLead: vi.fn(async () => 1),
    dueAt: vi.fn(async () => NOW),
  };
  const textBack = { restore: vi.fn(async () => undefined) };
  const leadState = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const events = { publish: vi.fn() };
  const service = new OutreachControlService(prisma as any, engine as any, followup as any, textBack as any, leadState as any, audit as any, events as any);
  return { service, prisma, tx, engine, followup, textBack, leadState, audit, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('who may control a lead', () => {
  it('looks the lead up within what the user may see: an agent only their own, an admin any', async () => {
    const s = setup();
    await s.service.state(agent, LEAD);
    expect((s.prisma.lead.findFirst.mock.calls[0] as any[])[0].where).toMatchObject({ id: LEAD, orgId: ORG, assignedToId: 'agent-1' });
    await s.service.state(admin, LEAD);
    expect((s.prisma.lead.findFirst.mock.calls[1] as any[])[0].where).not.toHaveProperty('assignedToId');
  });

  it('a lead out of reach is not found; a user without lead.update may look but not control', async () => {
    await expect(setup({ lead: null }).service.pausePlan(agent, LEAD)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await setup().service.state(viewer, LEAD)).canControl).toBe(false);
    expect((await setup().service.state(agent, LEAD)).canControl).toBe(true);
  });

  it('says who paused it and why, when a person did', async () => {
    const s = setup({ lead: { automationPaused: true }, lastControl: { type: 'outreach_paused', actorId: 'admin-1', reason: 'On holiday', createdAt: EARLIER, payload: {} } });
    expect(await s.service.state(admin, LEAD)).toEqual({ paused: true, pausedAt: EARLIER.toISOString(), pausedBy: 'Sunny Patel', reason: 'On holiday', canControl: true });
  });
});

describe('pausing', () => {
  it('lists what it holds, on the lead clock', async () => {
    const s = setup({ running: true, lead: { textBackAt: LATER, callbackAt: LATER }, sequences: [{ currentStep: 2, sequence: { name: 'Nurture 30' } }] });
    const plan = await s.service.pausePlan(admin, LEAD);
    expect(plan.lines).toEqual([
      'The outreach strategy, from its next step',
      'Sequence "Nurture 30", at step 2',
      'The text the AI promised for Friday, November 27 at 10:00 AM CST',
      'The callback the AI promised for Friday, November 27 at 10:00 AM CST, unless resumed before it',
    ]);
  });

  it('holds a new lead before its outreach starts', async () => {
    const s = setup({ lead: { status: 'new', firstContactAt: null }, canResume: false });
    expect((await s.service.pausePlan(admin, LEAD)).lines).toEqual(['Outreach does not start for this new lead']);
  });

  it('refuses when already paused, or nothing is running', async () => {
    await expect(setup({ lead: { automationPaused: true } }).service.pausePlan(admin, LEAD)).rejects.toThrow(/already paused/);
    await expect(setup({ lead: { status: 'not_interested' }, canResume: false }).service.pausePlan(admin, LEAD)).rejects.toThrow(/the lead is not interested/);
  });

  it('pauses in one go: the flag, the sequences, the promised text kept for later, the log; then the running steps', async () => {
    const s = setup({ running: true, lead: { textBackAt: LATER } });
    expect(await s.service.pause(agent, LEAD, { source: 'agent', reason: 'On holiday' })).toEqual({ paused: true, sequences: 1 });
    expect(s.tx.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG, automationPaused: false }, data: { automationPaused: true, textBackAt: null } });
    expect(s.followup.pauseForLead).toHaveBeenCalledWith(ORG, LEAD, s.tx);
    expect(s.leadState.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outreach_paused', source: 'agent', actor: { type: 'user', id: 'agent-1' }, reason: 'On holiday', payload: { textBackAt: LATER.toISOString(), sequences: 1 } }),
      s.tx,
    );
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'lead.outreach_paused', actorId: 'agent-1' }), s.tx);
    // No "strategy stopped": the strategy is held, not left, so it can go on.
    expect(s.engine.pauseStrategy).toHaveBeenCalledWith(LEAD);
  });

  it('loses a race to another pause without changing anything else', async () => {
    const s = setup({ running: true });
    s.tx.lead.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(s.service.pause(admin, LEAD, { source: 'agent' })).rejects.toThrow(/already paused/);
    expect(s.followup.pauseForLead).not.toHaveBeenCalled();
    expect(s.engine.pauseStrategy).not.toHaveBeenCalled();
  });
});

describe('resuming', () => {
  const pausedBy = (textBackAt: Date | null) => ({ type: 'outreach_paused', actorId: 'admin-1', reason: null, createdAt: EARLIER, payload: { textBackAt: textBackAt?.toISOString() ?? null } });

  it('says what goes on and what was lost during the pause', async () => {
    const s = setup({
      lead: { automationPaused: true, callbackAt: EARLIER },
      sequences: [{ currentStep: 3, sequence: { name: 'Nurture 30' } }],
      lastControl: pausedBy(EARLIER),
    });
    const plan = await s.service.resumePlan(admin, LEAD);
    expect(plan.lines).toEqual(['The outreach strategy goes on from its next step', 'Sequence "Nurture 30" goes on from step 3']);
    expect(plan.notes).toEqual([
      'The text the AI promised for Thursday, November 26 at 9:00 AM CST passed during the pause and is not sent.',
      'The callback the AI promised for Thursday, November 26 at 9:00 AM CST passed during the pause.',
    ]);
  });

  it('refuses a lead not paused, opted out, without consent or waiting for review', async () => {
    await expect(setup().service.resumePlan(admin, LEAD)).rejects.toThrow(/not paused/);
    await expect(setup({ lead: { automationPaused: true, dncStatus: true } }).service.resumePlan(admin, LEAD)).rejects.toThrow(/not to be contacted/);
    await expect(setup({ lead: { automationPaused: true, consentStatus: 'revoked' } }).service.resumePlan(admin, LEAD)).rejects.toThrow(/withdrew consent/);
    await expect(
      setup({ lead: { automationPaused: true, needsReview: true, reviewReasons: ['The lead texted something we could not read'] } }).service.resumePlan(admin, LEAD),
    ).rejects.toThrow(/waiting for review/);
  });

  it('lifts a pause the system made too, and says when nothing restarts by itself', async () => {
    const s = setup({ lead: { automationPaused: true, status: 'engaged' }, canResume: false });
    const plan = await s.service.resumePlan(admin, LEAD);
    expect(plan.lines).toEqual([]);
    expect(plan.notes).toEqual(['Nothing restarts by itself: its strategy has ended. It can be added to a sequence.']);
  });

  it('carries everything on: flag, sequences due now, the promised text, the strategy', async () => {
    const s = setup({ lead: { automationPaused: true, callbackAt: EARLIER }, lastControl: pausedBy(LATER) });
    expect(await s.service.resume(agent, LEAD, { source: 'assistant' })).toEqual({ strategy: 'continued', sequences: 1, textBackRestored: true });
    // The callback that passed is dropped so it holds nothing back.
    expect(s.tx.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG, automationPaused: true }, data: { automationPaused: false, callbackAt: null } });
    expect(s.followup.resumeForLead).toHaveBeenCalledWith(ORG, LEAD, NOW, s.tx);
    expect(s.leadState.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'outreach_resumed', source: 'assistant', actor: { type: 'user', id: 'agent-1' } }), s.tx);
    expect(s.textBack.restore).toHaveBeenCalledWith(ORG, LEAD, LATER);
    expect(s.engine.resume).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('starts a lead never contacted from its first step', async () => {
    const s = setup({ lead: { automationPaused: true, status: 'new', firstContactAt: null } });
    expect((await s.service.resume(admin, LEAD, { source: 'agent' })).strategy).toBe('started');
    expect(s.engine.enroll).toHaveBeenCalledWith(ORG, LEAD);
    expect(s.engine.resume).not.toHaveBeenCalled();
  });

  it('keeps a callback still ahead: the strategy goes on after it', async () => {
    const s = setup({ lead: { automationPaused: true, callbackAt: LATER }, resumed: false });
    expect((await s.service.resumePlan(admin, LEAD)).lines).toEqual(['The outreach strategy goes on after the callback on Friday, November 27 at 10:00 AM CST']);
    expect((await s.service.resume(admin, LEAD, { source: 'agent' })).strategy).toBe('after_callback');
    expect((s.tx.lead.updateMany.mock.calls[0] as any[])[0].data).toEqual({ automationPaused: false });
  });
});

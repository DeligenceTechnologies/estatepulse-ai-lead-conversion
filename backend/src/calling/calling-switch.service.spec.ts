import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallingSwitchService } from './calling-switch.service';

const ORG = 'org-1';
const readyRetell = { id: 'retell-row', apiKey: 'key_api', webhookKey: 'key_hook', agentId: 'agent_1', fromNumber: '+12025550100' };

function setup(opts: { from?: 'telnyx' | 'retell'; live?: number; retell?: Record<string, unknown> | null; telnyx?: Record<string, unknown> | null; smsSteps?: number; smsEnrollments?: number; booking?: boolean; smsReady?: boolean } = {}) {
  const tx = { integration: { updateMany: vi.fn(), update: vi.fn() } };
  const prisma = {
    integration: { findFirst: vi.fn().mockResolvedValue(opts.telnyx === undefined ? { id: 'telnyx-row', credentials: 'sealed', phoneNumber: '+12025550199' } : opts.telnyx) },
    sequenceEnrollment: {
      findMany: vi.fn().mockResolvedValue([
        ...Array.from({ length: opts.smsEnrollments ?? 0 }, () => ({ sequence: { steps: [{ actionType: 'voice' }, { actionType: 'sms' }] } })),
        { sequence: { steps: [{ actionType: 'voice' }] } },
      ]),
    },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const providers = { nameFor: vi.fn().mockResolvedValue(opts.from ?? 'telnyx'), for: vi.fn() };
  const retellCreds = { getCreds: vi.fn().mockResolvedValue(opts.retell === undefined ? readyRetell : opts.retell) };
  const slots = { inUse: vi.fn().mockResolvedValue(opts.live ?? 0) };
  const steps = [...Array.from({ length: opts.smsSteps ?? 0 }, () => ({ channel: 'sms' })), { channel: 'voice' }];
  const strategies = { getStrategy: vi.fn().mockResolvedValue({ steps }) };
  const booking = { activeConfig: vi.fn().mockResolvedValue(opts.booking ? { tokenHash: 'h' } : null), disable: vi.fn() };
  const audit = { record: vi.fn() };
  const retellSms = {
    capability: vi.fn(async () =>
      opts.smsReady
        ? { available: true, state: 'unverified', reason: 'Retell does not report A2P registration.', deliveryReports: false }
        : { available: false, state: 'not_configured', reason: 'SMS is not set up on Retell yet.', deliveryReports: false },
    ),
  };
  const svc = new CallingSwitchService(prisma as any, providers as any, retellCreds as any, slots as any, strategies as any, booking as any, audit as any, retellSms as any);
  return { svc, prisma, tx, booking, audit };
}

describe('CallingSwitchService.preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is clear to switch a ready organization, and says queued calls follow the new provider', async () => {
    const p = await setup().svc.preview(ORG, 'retell');
    expect(p).toMatchObject({ from: 'telnyx', to: 'retell', liveCalls: 0, blockers: [] });
    expect(p.warnings).toContain('Calls already queued will dial through the new provider, still inside the contact window.');
    expect(p.warnings).toContain('SMS will not be sent while you call through Retell: SMS is not set up on Retell yet.');
  });

  it('blocks while a call is live', async () => {
    expect((await setup({ live: 2 }).svc.preview(ORG, 'retell')).blockers).toContain('2 call(s) are live right now. Switch once they have ended.');
  });

  it('blocks a Retell account that is not set up, naming each missing piece', async () => {
    expect((await setup({ retell: null }).svc.preview(ORG, 'retell')).blockers).toEqual(['Connect a Retell account first.']);
    expect((await setup({ retell: { ...readyRetell, webhookKey: '', agentId: '', fromNumber: '' } }).svc.preview(ORG, 'retell')).blockers).toEqual([
      'Add the Retell webhook key.',
      'Create the Retell agent first.',
      'Choose the Retell number calls come from.',
    ]);
  });

  it('never blocks going back to Telnyx on its account, which can only be connected once Telnyx is the provider', async () => {
    const none = await setup({ from: 'retell', telnyx: null }).svc.preview(ORG, 'telnyx');
    expect(none.blockers).toEqual([]);
    expect(none.warnings).toContain('No Telnyx account is connected yet: no calls go out until you connect one after switching.');
    const noNumber = await setup({ from: 'retell', telnyx: { id: 't', credentials: 's', phoneNumber: null } }).svc.preview(ORG, 'telnyx');
    expect(noNumber.blockers).toEqual([]);
    expect(noNumber.warnings).toContain('Your saved Telnyx account has no number to call from yet: choose one after switching.');
    expect((await setup({ from: 'retell' }).svc.preview(ORG, 'telnyx')).warnings).toContain('Your saved Telnyx account is used again.');
    expect((await setup({ from: 'retell' }).svc.preview(ORG, 'retell')).blockers).toContain('This organization already calls through Retell.');
  });

  it('back to Telnyx with no Telnyx account just leaves Retell, so connecting Telnyx afterwards works', async () => {
    const { svc, tx, audit } = setup({ from: 'retell', telnyx: null });
    await svc.switch(ORG, 'telnyx', 'user-1');
    expect(tx.integration.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'inactive' } }));
    expect(tx.integration.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityId: null, payload: { from: 'retell', to: 'telnyx' } }), tx);
  });

  it('warns about SMS steps that will not be sent and about in-call booking', async () => {
    const p = await setup({ smsSteps: 2, smsEnrollments: 3, booking: true }).svc.preview(ORG, 'retell');
    expect(p.warnings).toContain('Your outreach strategy has 2 SMS step(s); they will not be sent while you call through Retell.');
    expect(p.warnings).toContain('3 lead(s) are in follow-up sequences with SMS steps; those steps will not be sent.');
    expect(p.warnings).toContain('In-call booking will be switched off; turn it on again once you are on Retell.');
  });
});

describe('CallingSwitchService.switch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('swaps the active calling integration in one transaction and audits it', async () => {
    const { svc, tx, audit } = setup();
    await svc.switch(ORG, 'retell', 'user-1');
    expect(tx.integration.updateMany).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: { in: ['telnyx', 'retell'] }, status: 'active' },
      data: { status: 'inactive' },
    });
    expect(tx.integration.update).toHaveBeenCalledWith({ where: { id: 'retell-row' }, data: { status: 'active' } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, actorId: 'user-1', action: 'calling_provider.switched', payload: { from: 'telnyx', to: 'retell' } }), tx);
  });

  it('back to Telnyx activates the Telnyx account used most recently', async () => {
    const { svc, tx, prisma } = setup({ from: 'retell' });
    await svc.switch(ORG, 'telnyx', 'user-1');
    expect(prisma.integration.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: ORG, provider: 'telnyx', revokedAt: null }, orderBy: { updatedAt: 'desc' } }));
    expect(tx.integration.update).toHaveBeenCalledWith({ where: { id: 'telnyx-row' }, data: { status: 'active' } });
  });

  it('turns in-call booking off on the provider being left, before switching', async () => {
    const { svc, booking, prisma } = setup({ booking: true });
    await svc.switch(ORG, 'retell', 'user-1');
    expect(booking.disable).toHaveBeenCalledWith(ORG);
    expect(booking.disable.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
  });

  it('changes nothing when anything blocks it', async () => {
    const { svc, prisma, booking } = setup({ live: 1, booking: true });
    await expect(svc.switch(ORG, 'retell', 'user-1')).rejects.toMatchObject({ status: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(booking.disable).not.toHaveBeenCalled();
  });
});

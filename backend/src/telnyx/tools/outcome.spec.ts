import { describe, expect, it, vi } from 'vitest';
import { OutcomeService } from './outcome.service';

function setup() {
  const tx = { lead: { update: vi.fn(async () => ({})) } };
  const prisma = {
    lead: { findFirst: vi.fn(async () => ({ id: 'lead-1' })), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const state = { quietly: vi.fn() };
  const optOuts = { optOut: vi.fn(async () => ['lead-1']) };
  const engine = { setStatus: vi.fn(async () => true), stopStrategy: vi.fn() };
  const service = new OutcomeService(prisma as any, state as any, optOuts as any, engine as any);
  return { service, prisma, tx, state, optOuts, engine };
}

const ON_CALL = { orgId: 'org-1', leadId: 'lead-1', callId: 'call-1' };

describe('OutcomeService.record', () => {
  it('not interested: ends the outreach now, and drops any callback', async () => {
    const s = setup();
    const r = await s.service.record(ON_CALL, { outcome: 'not_interested', note: 'already bought' });
    expect(r).toMatchObject({ ok: true, recorded: 'not_interested' });
    expect(r.say).toContain('hangup tool');
    expect(s.engine.setStatus).toHaveBeenCalledWith('org-1', 'lead-1', 'not_interested', expect.stringContaining('already bought'), { source: 'call' });
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { callbackAt: null } });
    expect(s.engine.stopStrategy).toHaveBeenCalled();
  });

  it('wrong number: the lead becomes invalid', async () => {
    const s = setup();
    await s.service.record({ ...ON_CALL, callId: null }, { outcome: 'wrong_number' });
    expect(s.engine.setStatus).toHaveBeenCalledWith('org-1', 'lead-1', 'invalid', expect.stringContaining('by text'), { source: 'sms_chat' });
  });

  it('do not contact: an opt-out for the number, in one transaction with the contact time', async () => {
    const s = setup();
    const r = await s.service.record(ON_CALL, { outcome: 'do_not_contact' });
    expect(r.ok).toBe(true);
    expect(s.tx.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { lastContactAt: expect.any(Date) } });
    expect(s.optOuts.optOut).toHaveBeenCalledWith(
      'org-1',
      { leadId: 'lead-1' },
      { source: 'call', reason: expect.stringContaining('Asked not to be contacted again'), channel: 'voice', callId: 'call-1' },
      s.tx,
    );
    expect(s.engine.setStatus).not.toHaveBeenCalled();
  });

  it('refuses an outcome it does not know, changing nothing', async () => {
    const s = setup();
    const r = await s.service.record(ON_CALL, { outcome: 'maybe_later' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_outcome' });
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
    expect(s.engine.setStatus).not.toHaveBeenCalled();
  });
});

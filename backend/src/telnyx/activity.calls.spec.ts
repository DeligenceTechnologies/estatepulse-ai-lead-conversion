import { describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/**
 * A call row moves one way only: dialing → live → over. Telnyx can deliver the
 * answered and hang-up webhooks out of order, or the same one twice; neither
 * may leave a call stuck live or overwrite how it ended.
 */
describe('ActivityService call row', () => {
  const CALL = { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', provider: 'telnyx', status: 'ringing', disposition: null, endedAt: null };

  const make = (row: { status: string; started_at: Date | null; disposition: string | null } | null) => {
    const tx = { $queryRaw: vi.fn(async () => (row ? [row] : [])), call: { update: vi.fn(async () => ({})) } };
    const prisma = {
      call: { findFirst: vi.fn(async () => CALL), updateMany: vi.fn(async () => ({ count: 1 })) },
      lead: { updateMany: vi.fn(async () => ({ count: 1 })), findUnique: vi.fn(async () => ({ callbackAt: null })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const slots = { extend: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    const state = { quietly: vi.fn(), move: vi.fn(async () => ({ moved: true, from: 'contacting' })) };
    const service = new ActivityService(prisma as any, {} as any, {} as any, {} as any, slots as any, { get: vi.fn() } as any, state as any, {} as any, {} as any);
    const attach = vi.fn(async () => undefined);
    (service as any).attach = attach;
    (service as any).prepareAttach = vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'a-1' }));
    return { service, prisma, tx, state, attach };
  };

  it('an answered event goes live only from dialing, and attaches the assistant then', async () => {
    const s = make(null);
    await s.service.onCallAnswered('cc-1');
    expect(s.prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: 'call-1', status: { in: ['queued', 'ringing'] } },
      data: expect.objectContaining({ status: 'in_progress' }),
    });
    expect(s.attach).toHaveBeenCalledOnce();
  });

  it('an answered event that arrives after the hang-up, or twice, does nothing more', async () => {
    const s = make(null);
    s.prisma.call.updateMany.mockResolvedValue({ count: 0 });
    await s.service.onCallAnswered('cc-1');
    expect(s.attach).not.toHaveBeenCalled();
  });

  it('a hang-up closes a live call as completed, with its disposition and length in the same write', async () => {
    const s = make({ status: 'in_progress', started_at: new Date(Date.now() - 60_000), disposition: null });
    await s.service.onCallHangup('cc-1', { hangup_cause: 'normal_clearing' });
    expect(s.tx.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: expect.objectContaining({ status: 'completed', disposition: 'connected', durationSeconds: 60, endedAt: expect.any(Date) }),
    });
    expect(s.state.move).toHaveBeenCalledWith('lead-1', 'engaged', expect.objectContaining({ callId: 'call-1' }));
  });

  it('a hang-up before any answer closes the call as not answered', async () => {
    const s = make({ status: 'ringing', started_at: null, disposition: null });
    await s.service.onCallHangup('cc-1', { hangup_cause: 'timeout' });
    expect(s.tx.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: expect.objectContaining({ status: 'no_answer', disposition: 'no_answer' }) });
  });

  it('the same hang-up again leaves the call as it ended: no second write, no second event', async () => {
    const s = make({ status: 'completed', started_at: new Date(Date.now() - 60_000), disposition: 'connected' });
    await s.service.onCallHangup('cc-1', { hangup_cause: 'normal_clearing' });
    expect(s.tx.call.update).not.toHaveBeenCalled();
    expect(s.state.quietly).not.toHaveBeenCalled();
    expect(s.state.move).not.toHaveBeenCalled();
  });
});

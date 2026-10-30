import { describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/**
 * A call on another provider (Retell): the row carries its provider, no
 * Telnyx assistant is prepared or attached, and the provider's own voicemail
 * verdict decides the disposition.
 */
describe('ActivityService with a non-Telnyx call', () => {
  const CALL = { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', provider: 'retell', status: 'ringing', disposition: null, endedAt: null };

  const make = (row: { status: string; started_at: Date | null; disposition: string | null } | null = null) => {
    const tx = { $queryRaw: vi.fn(async () => (row ? [row] : [])), call: { update: vi.fn(async () => ({})) } };
    const prisma = {
      call: { create: vi.fn(async () => ({ id: 'call-new' })), findFirst: vi.fn(async () => CALL), updateMany: vi.fn(async () => ({ count: 1 })) },
      lead: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })), findUnique: vi.fn(async () => ({ callbackAt: null })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const creds = { getCreds: vi.fn() };
    const slots = { extend: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    const state = { quietly: vi.fn(), move: vi.fn(async () => ({ moved: true, from: 'contacting' })) };
    const service = new ActivityService(prisma as any, creds as any, {} as any, {} as any, slots as any, { get: vi.fn() } as any, state as any, {} as any, {} as any);
    const attach = vi.fn(async () => undefined);
    const prepareAttach = vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'a-1' }));
    (service as any).attach = attach;
    (service as any).prepareAttach = prepareAttach;
    return { service, prisma, tx, state, slots, creds, attach, prepareAttach };
  };

  it('records the call under its provider and prepares no Telnyx assistant', async () => {
    const s = make();
    await s.service.startCall('org-1', 'lead-1', 'call_abc', {}, 'retell');
    await s.service.recordCallFailed('org-1', 'lead-1', 'boom', undefined, 'retell');
    expect(s.prisma.call.create).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'retell', providerCallId: 'call_abc', status: 'ringing' }) });
    expect(s.prisma.call.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ provider: 'retell', status: 'failed' }) }));
    expect(s.prepareAttach).not.toHaveBeenCalled();
    expect(s.creds.getCreds).not.toHaveBeenCalled();
  });

  it('still prepares the Telnyx assistant for a Telnyx call', async () => {
    const s = make();
    await s.service.startCall('org-1', 'lead-1', 'v3:cc-1');
    expect(s.prepareAttach).toHaveBeenCalledWith('v3:cc-1', 'org-1', 'lead-1', {});
  });

  it('on answer does the bookkeeping only: the provider’s own agent is already on the line', async () => {
    const s = make();
    await s.service.onCallAnswered('call_abc');
    expect(s.prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: 'call-1', status: { in: ['queued', 'ringing'] } },
      data: expect.objectContaining({ status: 'in_progress' }),
    });
    expect(s.slots.extend).toHaveBeenCalledWith('org-1', 'call_abc');
    expect(s.attach).not.toHaveBeenCalled();
    expect(s.prepareAttach).not.toHaveBeenCalled();
  });

  it('a call the provider’s voicemail detection ended is a voicemail, not a conversation', async () => {
    const s = make({ status: 'in_progress', started_at: new Date(Date.now() - 45_000), disposition: null });
    await s.service.onCallHangup('call_abc', { hangup_cause: 'voicemail_reached', machine: true });
    expect(s.tx.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: expect.objectContaining({ status: 'completed', disposition: 'voicemail' }) });
    expect(s.state.move).not.toHaveBeenCalled();
    expect(s.slots.release).toHaveBeenCalledWith('org-1', 'call_abc');
  });
});

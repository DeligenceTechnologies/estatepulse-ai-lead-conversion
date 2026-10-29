import { describe, expect, it, vi } from 'vitest';
import { CallingProviders, SMS_READY, TelnyxCallingProvider } from './calling-providers';

const ORG = 'org-1';
const config = (on: boolean) => ({ get: vi.fn((key: string) => (key === 'RETELL_ENABLED' ? on : undefined)) });
const prismaWith = (retellRow: unknown) => ({ integration: { findFirst: vi.fn().mockResolvedValue(retellRow) } });
const telnyx = () => new TelnyxCallingProvider({} as any, {} as any, {} as any);
const retellProvider = { name: 'retell', capabilities: { sms: false } } as any;

describe('CallingProviders', () => {
  it('flag off: every organization is on Telnyx, and the database is never read', async () => {
    const prisma = prismaWith({ id: 'retell-row' });
    const t = telnyx();
    const providers = new CallingProviders(config(false) as any, prisma as any, t, retellProvider);
    expect(await providers.nameFor(ORG)).toBe('telnyx');
    expect(await providers.for(ORG)).toBe(t);
    expect(prisma.integration.findFirst).not.toHaveBeenCalled();
  });

  it('flag on: Telnyx unless the organization’s active calling integration is Retell', async () => {
    const none = prismaWith(null);
    const t = telnyx();
    const onTelnyx = new CallingProviders(config(true) as any, none as any, t, retellProvider);
    expect(await onTelnyx.nameFor(ORG)).toBe('telnyx');
    expect(await onTelnyx.for(ORG)).toBe(t);
    expect(none.integration.findFirst).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: 'retell', status: 'active', revokedAt: null },
      select: { id: true },
    });
    const onRetell = new CallingProviders(config(true) as any, prismaWith({ id: 'retell-row' }) as any, telnyx(), retellProvider);
    expect(await onRetell.nameFor(ORG)).toBe('retell');
    expect(await onRetell.for(ORG)).toBe(retellProvider);
  });
});

describe('TelnyxCallingProvider', () => {
  it('hands each call to the existing Telnyx services unchanged', async () => {
    const voice = { placeCall: vi.fn().mockResolvedValue({ call_control_id: 'cc-1' }) };
    const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
    const capacity = { status: vi.fn().mockResolvedValue({ telnyxLimit: 7 }) };
    const p = new TelnyxCallingProvider(voice as any, sms as any, capacity as any);

    expect(p.name).toBe('telnyx');
    expect(p.capabilities).toEqual({ sms: true });
    expect(await p.startCall(ORG, '+12895550111', { leadId: 'lead-1', orgId: ORG })).toEqual({ providerCallId: 'cc-1' });
    expect(voice.placeCall).toHaveBeenCalledWith(ORG, '+12895550111', { leadId: 'lead-1', orgId: ORG });
    // Key order reaches Telnyx's base64 client_state, so it stays as the caller built it.
    expect(Object.keys(voice.placeCall.mock.calls[0][2])).toEqual(['leadId', 'orgId']);
    expect(await p.smsCapability()).toEqual(SMS_READY);
    expect(await p.sendSms(ORG, '+12895550111', 'Hi')).toEqual({ id: 'msg-1' });
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Hi');
    expect(await p.providerLimit(ORG)).toBe(7);
  });
});

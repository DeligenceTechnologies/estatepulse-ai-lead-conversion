import { describe, expect, it, vi } from 'vitest';
import { sha256 } from './in-call-booking-settings.service';
import { ToolAuthService, type ToolRequest } from './tool-auth.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'org-1';
const LEAD = 'lead-1';
const CCID = 'v3:call-1';
const TOKEN = 'the-office-token';

function setup(opts: { call?: any; config?: any; publicKey?: string; env?: string } = {}) {
  const unscoped: any = {
    voice_calls: {
      findFirst: vi.fn().mockResolvedValue(
        opts.call === undefined ? { id: 'call-1', organization_id: ORG, lead_id: LEAD, status: 'in_progress' } : opts.call,
      ),
    },
  };
  const settings: any = {
    activeConfig: vi.fn().mockResolvedValue(opts.config === undefined ? { tokenHash: sha256(TOKEN), eventTypeUri: 'et' } : opts.config),
  };
  const creds: any = { getCreds: vi.fn().mockResolvedValue({ publicKey: opts.publicKey ?? '' }) };
  const config: any = { get: () => opts.env ?? 'production' };
  return { svc: new ToolAuthService(unscoped, settings, creds, config), unscoped };
}

const req = (over: Partial<ToolRequest> = {}): ToolRequest => ({
  authorization: `Bearer ${TOKEN}`,
  signature: undefined,
  timestamp: undefined,
  rawBody: undefined,
  callControlId: CCID,
  leadId: LEAD,
  ...over,
});

describe('ToolAuthService.verify', () => {
  it('accepts the office token, on a live call, for that call’s lead — org taken from the call', async () => {
    const { svc, unscoped } = setup();
    const ctx = await svc.verify(req());
    expect(ctx).toMatchObject({ organizationId: ORG, leadId: LEAD, callId: 'call-1' });
    expect(unscoped.voice_calls.findFirst.mock.calls[0][0].where).toEqual({ provider_call_id: CCID });
  });

  it.each([
    ['no token', req({ authorization: undefined })],
    ['a wrong token', req({ authorization: 'Bearer nope' })],
    ['no call id', req({ callControlId: undefined })],
  ])('refuses %s', async (_label, r) => {
    await expect(setup().svc.verify(r)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses an unknown call, an ended call, and an office with booking off', async () => {
    await expect(setup({ call: null }).svc.verify(req())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      setup({ call: { id: 'c', organization_id: ORG, lead_id: LEAD, status: 'completed' } }).svc.verify(req()),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(setup({ config: null }).svc.verify(req())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it("always acts on the call's own lead, whatever lead_id says (missing, unrendered or another lead)", async () => {
    for (const leadId of [undefined, '{{leadId}}', 'lead-2']) {
      const ctx = await setup().svc.verify(req({ leadId }));
      expect(ctx.leadId).toBe(LEAD);
    }
  });

  it("refuses another office's token: the hash is the call's organization's", async () => {
    const other = setup({ config: { tokenHash: sha256('another-office-token') } });
    await expect(other.svc.verify(req())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('names the failed check only outside production', async () => {
    await expect(setup().svc.verify(req({ authorization: 'Bearer nope' }))).rejects.toMatchObject({ message: 'Not authorized' });
    await expect(setup({ env: 'development' }).svc.verify(req({ authorization: 'Bearer nope' }))).rejects.toMatchObject({
      message: 'Not authorized: bad token',
    });
  });

  it('checks the Telnyx signature when the office has a public key', async () => {
    const { svc } = setup({ publicKey: Buffer.alloc(32, 1).toString('base64') });
    await expect(svc.verify(req({ signature: 'AAAA', timestamp: String(Math.floor(Date.now() / 1000)), rawBody: Buffer.from('{}') })))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

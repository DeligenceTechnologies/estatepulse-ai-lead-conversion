import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/common/utils/crypto';
import { AssistantToolAuth } from '@/telnyx/tools/assistant-tool-auth.service';
import { ToolAuthService } from './tool-auth.service';

const TOKEN = 'secret-token';
const LEAD = '01a17814-1da6-79f0-9b9c-dda4ed09c775';

function setup(opts: { texting?: boolean; call?: { status: string } | null } = {}) {
  const prisma = {
    call: { findFirst: vi.fn(async () => (opts.call === undefined ? null : opts.call && { id: 'call-1', orgId: 'org-1', leadId: LEAD, ...opts.call })) },
    lead: {
      findUnique: vi.fn(async () => ({ id: LEAD, orgId: 'org-1', normalizedPhone: '+12899174129' })),
      findMany: vi.fn(async () => [{ id: LEAD, orgId: 'org-1', normalizedPhone: '+12899174129' }]),
    },
    organizationSetting: { findUnique: vi.fn(async () => ({ smsConversation: opts.texting ? { enabled: true } : null })) },
  };
  const settings = { activeConfig: vi.fn(async () => ({ tokenHash: sha256Hex(TOKEN), eventTypeUri: 'et' })) };
  const creds = { getCreds: vi.fn(async () => ({ publicKey: '' })) };
  const auth = new AssistantToolAuth(prisma as any, creds as any, { get: () => 'development' } as any);
  const service = new ToolAuthService(auth, settings as any, prisma as any, {} as any, { get: () => 'development' } as any);
  const request = (body: Record<string, unknown>) => ({
    authorization: `Bearer ${TOKEN}`,
    signature: undefined,
    timestamp: undefined,
    rawBody: undefined,
    callControlId: body.call_control_id,
    leadId: body.lead_id,
    endUser: body.end_user,
  });
  return { service, request };
}

describe('ToolAuthService', () => {
  it('accepts a tool used during a live call, as before', async () => {
    const s = setup({ call: { status: 'in_progress' } });
    const ctx = await s.service.verify(s.request({ call_control_id: 'v3:abc', lead_id: LEAD }));
    expect(ctx).toMatchObject({ orgId: 'org-1', leadId: LEAD, callId: 'call-1' });
  });

  it('accepts a tool used in a text chat: no call, the lead of an org that has text conversations on', async () => {
    const s = setup({ texting: true });
    const ctx = await s.service.verify(s.request({ call_control_id: '', lead_id: LEAD, end_user: '+1 (289) 917-4129' }));
    expect(ctx).toMatchObject({ orgId: 'org-1', leadId: LEAD, callId: null });
  });

  it('finds the chat lead by its number when Telnyx leaves {{leadId}} unfilled, as it does in a text chat', async () => {
    const s = setup({ texting: true });
    const ctx = await s.service.verify(s.request({ call_control_id: '{{call_control_id}}', lead_id: '{{leadId}}', end_user: '+12899174129' }));
    expect(ctx).toMatchObject({ orgId: 'org-1', leadId: LEAD, callId: null });
  });

  it('treats an unfilled {{call_control_id}} as no call', async () => {
    const s = setup({ texting: true });
    const ctx = await s.service.verify(s.request({ call_control_id: '{{call_control_id}}', lead_id: LEAD }));
    expect(ctx.callId).toBeNull();
  });

  it('refuses a text chat when the org has not turned text conversations on', async () => {
    const s = setup({ texting: false });
    await expect(s.service.verify(s.request({ lead_id: LEAD, end_user: '+12899174129' }))).rejects.toThrow(/text conversations are off/);
  });

  it("refuses a text chat whose number is not the lead's", async () => {
    const s = setup({ texting: true });
    await expect(s.service.verify(s.request({ lead_id: LEAD, end_user: '+15550001111' }))).rejects.toThrow(/not lead/);
  });

  it('refuses a wrong token', async () => {
    const s = setup({ texting: true });
    await expect(s.service.verify({ ...s.request({ lead_id: LEAD }), authorization: 'Bearer nope' })).rejects.toThrow(/bad token/);
  });
});

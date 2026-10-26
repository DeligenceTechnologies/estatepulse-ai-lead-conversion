import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/common/utils/crypto';
import { InCallBookingSettingsService } from './in-call-booking-settings.service';
import { ToolAuthService, type ToolRequest } from './tool-auth.service';

/** Characterization: who may call the Telnyx booking tools, and the tools as Telnyx receives them. */

const TOKEN = 'tok_live_123';
const config = { eventTypeUri: 'et-1', eventTypeName: 'Consultation', durationMinutes: 30, tokenHash: sha256Hex(TOKEN), secretId: 's', secretIdentifier: 'i', toolIds: [], assistantId: 'a' };

function setup(opts: { call?: Record<string, unknown> | null; config?: unknown; publicKey?: string; env?: string } = {}) {
  const call = opts.call === undefined ? { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', status: 'in_progress' } : opts.call;
  const prisma = { call: { findFirst: vi.fn().mockResolvedValue(call) } };
  const settings = { activeConfig: vi.fn().mockResolvedValue(opts.config === undefined ? config : opts.config) };
  const creds = { getCreds: vi.fn().mockResolvedValue({ publicKey: opts.publicKey ?? '' }) };
  const env = { get: vi.fn(() => opts.env ?? 'test') };
  return { auth: new ToolAuthService(prisma as any, settings as any, creds as any, env as any, {} as any), prisma };
}

const req = (over: Partial<ToolRequest> = {}): ToolRequest => ({
  authorization: `Bearer ${TOKEN}`,
  signature: undefined,
  timestamp: undefined,
  rawBody: Buffer.from('{}'),
  callControlId: 'v3:cc-1',
  leadId: 'lead-1',
  ...over,
});

describe('ToolAuthService.verify', () => {
  it('admits a live call with the right token, taking org and lead from the call', async () => {
    const { auth, prisma } = setup();
    await expect(auth.verify(req({ leadId: 'someone-else' }))).resolves.toEqual({ orgId: 'org-1', leadId: 'lead-1', callId: 'call-1', config });
    expect(prisma.call.findFirst).toHaveBeenCalledWith({
      where: { providerCallId: 'v3:cc-1' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, orgId: true, leadId: true, status: true },
    });
  });

  it.each([
    ['no bearer token', setup(), req({ authorization: undefined })],
    ['no call_control_id', setup(), req({ callControlId: undefined })],
    ['unknown call', setup({ call: null }), req()],
    ['in-call booking is off', setup({ config: null }), req()],
    ['bad token', setup(), req({ authorization: 'Bearer wrong' })],
    ['call call-1 is completed, not live', setup({ call: { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', status: 'completed' } }), req()],
    ['bad Telnyx signature', setup({ publicKey: Buffer.alloc(32).toString('base64') }), req()],
  ])('refuses: %s', async (why, { auth }, request) => {
    await expect(auth.verify(request)).rejects.toThrow(`Not authorized: ${why}`);
  });

  it('gives no reason in production', async () => {
    const { auth } = setup({ env: 'production' });
    await expect(auth.verify(req({ authorization: undefined }))).rejects.toThrow(/^Not authorized$/);
  });
});

describe('InCallBookingSettingsService.toolDefinitions', () => {
  it('points both Telnyx webhook tools at /tools/telnyx/booking with the call tied in by preset fields', () => {
    const svc = new InCallBookingSettingsService({} as any, {} as any, {} as any, {} as any, { get: () => 'https://api.example.com/' } as any, {} as any, {} as any);
    const tools = svc.toolDefinitions('ep_booking_org1');
    expect(
      tools.map((t) => ({
        type: t.type,
        name: t.webhook.name,
        url: t.webhook.url,
        method: t.webhook.method,
        headers: t.webhook.headers,
        preset: t.webhook.preset_body_fields,
        required: t.webhook.body_parameters.required,
        params: Object.keys(t.webhook.body_parameters.properties),
        timeout: t.timeout_ms,
      })),
    ).toEqual([
      {
        type: 'webhook',
        name: 'check_availability',
        url: 'https://api.example.com/tools/telnyx/booking/availability',
        method: 'POST',
        headers: [{ name: 'Authorization', value: 'Bearer {{#integration_secret}}ep_booking_org1{{/integration_secret}}' }],
        preset: { lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}' },
        required: [],
        params: ['day', 'preferred_time'],
        timeout: 15000,
      },
      {
        type: 'webhook',
        name: 'book_appointment',
        url: 'https://api.example.com/tools/telnyx/booking/book',
        method: 'POST',
        headers: [{ name: 'Authorization', value: 'Bearer {{#integration_secret}}ep_booking_org1{{/integration_secret}}' }],
        preset: { lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}' },
        required: ['start_time'],
        params: ['start_time', 'email', 'name'],
        timeout: 20000,
      },
    ]);
  });
});

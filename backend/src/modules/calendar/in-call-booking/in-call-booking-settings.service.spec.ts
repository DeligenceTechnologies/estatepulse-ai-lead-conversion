import { beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const telnyx = vi.fn();
vi.mock('../../../telnyx/lead-insights.service', () => ({ telnyx: (...a: unknown[]) => telnyx(...a) }));

import { BOOKING_PROMPT_START } from './booking-prompt';
import { InCallBookingSettingsService, sha256 } from './in-call-booking-settings.service';

const OFFICE_PROMPT = '# Role\nYou are the assistant for Austin Homes.';

const ORG = '11111111-1111-4111-8111-111111111111';
const RR = 'https://api.calendly.com/event_types/rr';
const ONE_ON_ONE = 'https://api.calendly.com/event_types/solo';
const MULTI = 'https://api.calendly.com/event_types/multi';
const FULL_SCOPE = 'users:read scheduled_events:read availability:read scheduled_events:write';

function setup(opts: { scope?: string; provider?: string; assistantId?: string; row?: any } = {}) {
  const prisma: any = {
    integrations: {
      findFirst: vi.fn().mockResolvedValue(opts.row ?? null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const config: any = { get: () => 'https://api.example.com/' };
  const creds: any = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', assistantId: opts.assistantId ?? 'asst-1' }) };
  const connections: any = {
    syncableOrgRow: vi.fn().mockResolvedValue({ provider: opts.provider ?? 'calendly', metadata: { scope: opts.scope ?? FULL_SCOPE } }),
  };
  const eventTypes: any = {
    list: vi.fn().mockResolvedValue([
      { uri: RR, name: 'Buyer consult', durationMinutes: 30, poolingType: 'round_robin' },
      { uri: ONE_ON_ONE, name: 'Sunny 1:1', durationMinutes: 30, poolingType: null },
      { uri: MULTI, name: 'Buyer Consultation', durationMinutes: 30, poolingType: 'multi_pool' },
      { uri: 'https://api.calendly.com/event_types/all', name: 'Everyone', durationMinutes: 30, poolingType: 'collective' },
    ]),
  };
  const roster: any = { listMembers: vi.fn().mockResolvedValue([{ name: 'Sunny', agentId: 'a1' }, { name: 'Pat', agentId: null }]) };
  return { svc: new InCallBookingSettingsService(prisma, config, creds, connections, eventTypes, roster), prisma };
}

beforeEach(() => {
  telnyx.mockReset();
  telnyx.mockImplementation(async (_k: string, path: string, init?: any) =>
    path === '/integration_secrets'
      ? { data: { id: 'sec-1' } }
      : path === '/ai/tools'
        ? { id: `tool-${telnyx.mock.calls.length}` }
        : path === '/ai/assistants/asst-1' && !init?.method
          ? { data: { instructions: OFFICE_PROMPT } }
          : {},
  );
});

describe('status', () => {
  it('offers round-robin and multi-pool event types (not one-on-one or collective), flags missing scopes and unlinked members', async () => {
    const st = await setup({ scope: 'users:read scheduled_events:read' }).svc.status(ORG);
    expect(st.eventTypes.map((e) => e.uri)).toEqual([RR, MULTI]);
    expect(st.calendly).toEqual({ connected: true, scopesOk: false });
    expect(st.unlinkedMembers).toEqual(['Pat']);
    expect(st.enabled).toBe(false);
  });
});

describe('enable', () => {
  it('refuses until Calendly has been reconnected with the booking scopes', async () => {
    await expect(setup({ scope: 'users:read' }).svc.enable(ORG, RR)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(telnyx).not.toHaveBeenCalled();
  });

  it('refuses a non-round-robin event type, and Cal.com', async () => {
    await expect(setup().svc.enable(ORG, ONE_ON_ONE)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(setup({ provider: 'cal' }).svc.enable(ORG, RR)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('creates a secret and two attached tools, and stores only the token hash', async () => {
    const { svc, prisma } = setup();
    await svc.enable(ORG, RR);

    const secretCall = telnyx.mock.calls.find((c) => c[1] === '/integration_secrets')!;
    const token = JSON.parse(secretCall[2].body).token as string;
    const tools = telnyx.mock.calls.filter((c) => c[1] === '/ai/tools').map((c) => JSON.parse(c[2].body));
    expect(tools.map((t) => t.webhook.name)).toEqual(['check_availability', 'book_appointment']);
    for (const t of tools) {
      expect(t.webhook.url).toMatch(/^https:\/\/api\.example\.com\/api\/tools\/telnyx\/booking\//);
      expect(t.webhook.preset_body_fields).toEqual({ lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}' });
      expect(JSON.stringify(t)).not.toContain(token);
    }
    expect(telnyx.mock.calls.filter((c) => c[2]?.method === 'PUT' && c[1].startsWith('/ai/assistants/asst-1/tools/'))).toHaveLength(2);

    const saved = prisma.integrations.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({ organization_id: ORG, provider: 'in_call_booking', status: 'active' });
    expect(saved.metadata.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(saved.metadata)).not.toContain(token);
  });

  it("appends the booking section to the office's own prompt", async () => {
    await setup().svc.enable(ORG, RR);
    const patch = telnyx.mock.calls.find((c) => c[1] === '/ai/assistants/asst-1' && c[2]?.method === 'PATCH')!;
    const instructions = JSON.parse(patch[2].body).instructions as string;
    expect(instructions.startsWith(OFFICE_PROMPT + '\n\n' + BOOKING_PROMPT_START)).toBe(true);
    expect(instructions).toContain('"Buyer consult"');
  });

  it("reads the assistant as Telnyx actually returns it (top level, not under data) and keeps the office's prompt", async () => {
    telnyx.mockImplementation(async (_k: string, path: string, init?: any) =>
      path === '/integration_secrets'
        ? { data: { id: 'sec-1' } }
        : path === '/ai/tools'
          ? { id: 'tool-1' }
          : path === '/ai/assistants/asst-1' && !init?.method
            ? { id: 'asst-1', instructions: OFFICE_PROMPT }
            : {},
    );
    await setup().svc.enable(ORG, RR);
    const patch = telnyx.mock.calls.find((c) => c[1] === '/ai/assistants/asst-1' && c[2]?.method === 'PATCH')!;
    expect(JSON.parse(patch[2].body).instructions.startsWith(OFFICE_PROMPT + '\n\n')).toBe(true);
  });

  it('never overwrites a prompt it could not read', async () => {
    telnyx.mockImplementation(async (_k: string, path: string, init?: any) =>
      path === '/integration_secrets' ? { data: { id: 'sec-1' } } : path === '/ai/tools' ? { id: 'tool-1' } : path === '/ai/assistants/asst-1' && !init?.method ? {} : {},
    );
    await expect(setup().svc.enable(ORG, RR)).rejects.toThrow(/prompt/);
    expect(telnyx.mock.calls.some((c) => c[2]?.method === 'PATCH')).toBe(false);
  });

  it('rolls everything back if the prompt cannot be updated', async () => {
    telnyx.mockImplementation(async (_k: string, path: string, init?: any) => {
      if (path === '/integration_secrets') return { data: { id: 'sec-1' } };
      if (path === '/ai/tools') return { id: 'tool-x' };
      if (path === '/ai/assistants/asst-1' && init?.method === 'PATCH') throw new Error('prompt update failed');
      if (path === '/ai/assistants/asst-1') return { data: { instructions: OFFICE_PROMPT } };
      return {};
    });
    const { svc, prisma } = setup();
    await expect(svc.enable(ORG, RR)).rejects.toThrow('prompt update failed');
    const deletes = telnyx.mock.calls.filter((c) => c[2]?.method === 'DELETE').map((c) => c[1]);
    expect(deletes).toEqual(expect.arrayContaining(['/ai/tools/tool-x', '/integration_secrets/sec-1']));
    expect(prisma.integrations.create).not.toHaveBeenCalled();
  });

  it('removes what it created when Telnyx fails part-way', async () => {
    telnyx.mockImplementation(async (_k: string, path: string, init?: any) => {
      if (path === '/integration_secrets') return { data: { id: 'sec-1' } };
      if (path === '/ai/tools' && init?.method === 'POST') {
        if (telnyx.mock.calls.filter((c) => c[1] === '/ai/tools').length > 1) throw new Error('telnyx down');
        return { id: 'tool-1' };
      }
      return {};
    });
    const { svc, prisma } = setup();
    await expect(svc.enable(ORG, RR)).rejects.toThrow('telnyx down');
    const deletes = telnyx.mock.calls.filter((c) => c[2]?.method === 'DELETE').map((c) => c[1]);
    expect(deletes).toEqual(expect.arrayContaining(['/ai/tools/tool-1', '/integration_secrets/sec-1']));
    expect(prisma.integrations.create).not.toHaveBeenCalled();
  });
});

describe('disable', () => {
  it("removes only the booking section from the prompt, keeping the office's text", async () => {
    telnyx.mockImplementation(async (_k: string, path: string, init?: any) =>
      path === '/ai/assistants/asst-1' && !init?.method
        ? { data: { instructions: `${OFFICE_PROMPT}\n\n${BOOKING_PROMPT_START}\nstuff\n[End of EstatePulse appointment booking]` } }
        : {},
    );
    const row = { id: 'row-1', status: 'active', metadata: { toolIds: [], secretId: 'sec-1', assistantId: 'asst-1' } };
    await setup({ row }).svc.disable(ORG);
    const patch = telnyx.mock.calls.find((c) => c[2]?.method === 'PATCH')!;
    expect(JSON.parse(patch[2].body).instructions).toBe(OFFICE_PROMPT);
  });

  it('detaches and deletes the tools and the secret, and switches the row off', async () => {
    const row = {
      id: 'row-1',
      status: 'active',
      metadata: { toolIds: ['t1', 't2'], secretId: 'sec-1', assistantId: 'asst-1', tokenHash: 'h' },
    };
    const { svc, prisma } = setup({ row });
    await svc.disable(ORG);
    const deletes = telnyx.mock.calls.filter((c) => c[2]?.method === 'DELETE').map((c) => c[1]);
    expect(deletes).toEqual([
      '/ai/assistants/asst-1/tools/t1',
      '/ai/tools/t1',
      '/ai/assistants/asst-1/tools/t2',
      '/ai/tools/t2',
      '/integration_secrets/sec-1',
    ]);
    expect(prisma.integrations.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-1' }, data: expect.objectContaining({ status: 'inactive', metadata: {} }) }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AssistantSettingsService, assistantSettings } from './assistant-settings.service';
import { AssistantUsageService } from './assistant-usage.service';

const ORG = 'org-1';
const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['organization.read', 'organization.update'] };

function setup(stored: unknown = null, actions: object[] = []) {
  const tx = { organizationSetting: { upsert: vi.fn(async () => ({})) } };
  const prisma = {
    organizationSetting: { findUnique: vi.fn(async () => ({ assistant: stored })) },
    assistantAction: { findMany: vi.fn(async () => actions) },
    user: { findMany: vi.fn(async () => [{ id: 'owner-1', firstName: 'Sunny', lastName: 'Patel', email: 's@x.test' }]) },
    role: { findMany: vi.fn(async () => [{ name: 'Owner' }, { name: 'Agent' }]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { record: vi.fn(async () => undefined) };
  return { prisma, tx, audit, service: new AssistantSettingsService(prisma as any, audit as any) };
}

describe('assistant settings', () => {
  it('lists the roles that may use it: the system role, and roles holding assistant.use', async () => {
    const s = setup();
    expect(await s.service.rolesWithAccess(ORG)).toEqual(['Owner', 'Agent']);
    expect(s.prisma.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG, OR: [{ isSystem: true }, { permissions: { has: 'assistant.use' } }] } }),
    );
  });

  it('defaults to on, the plan allowance and the microphone on; a bad value counts as missing', () => {
    expect(assistantSettings(null)).toEqual({ enabled: true, monthlyLimitUsd: null, voiceEnabled: true });
    expect(assistantSettings({ enabled: 'no', monthlyLimitUsd: -5, voiceEnabled: false })).toEqual({ enabled: true, monthlyLimitUsd: null, voiceEnabled: false });
  });

  it('changes only what is sent, and logs the change with before and after', async () => {
    const s = setup({ enabled: true, monthlyLimitUsd: 50, voiceEnabled: true });
    const next = await s.service.update(owner, { voiceEnabled: false });
    expect(next).toEqual({ enabled: true, monthlyLimitUsd: 50, voiceEnabled: false });
    expect(s.tx.organizationSetting.upsert).toHaveBeenCalledWith({ where: { orgId: ORG }, create: { orgId: ORG, assistant: next }, update: { assistant: next } });
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'organization.assistant_settings_updated', actorId: 'owner-1', payload: { before: { enabled: true, monthlyLimitUsd: 50, voiceEnabled: true }, after: next } }),
      s.tx,
    );
  });

  it('a limit of null goes back to the plan allowance; a limit out of range is refused', async () => {
    expect((await setup({ monthlyLimitUsd: 50 }).service.update(owner, { monthlyLimitUsd: null })).monthlyLimitUsd).toBeNull();
    await expect(setup().service.update(owner, { monthlyLimitUsd: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(setup().service.update(owner, { monthlyLimitUsd: 1_000_000 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it("the log names who asked and what each step did, from its card or the tool's label", async () => {
    const at = new Date('2026-11-26T10:00:00Z');
    const s = setup(null, [
      { id: 'a1', createdAt: at, userId: 'owner-1', toolName: 'text_send', tier: 'write', status: 'executed', preview: { title: 'Text Maria Lopez' }, error: null },
      { id: 'a2', createdAt: at, userId: 'gone', toolName: 'lead_search', tier: 'read', status: 'executed', preview: null, error: null },
    ]);
    const { entries, nextCursor } = await s.service.log(owner, (tool) => (tool === 'lead_search' ? 'Searching leads' : tool));
    expect(entries.map((e) => [e.user, e.what, e.status])).toEqual([
      ['Sunny Patel', 'Text Maria Lopez', 'executed'],
      [null, 'Searching leads', 'executed'],
    ]);
    expect(nextCursor).toBeNull();
    expect((s.prisma.assistantAction.findMany.mock.calls[0] as any[])[0].where).toEqual({ orgId: ORG });
  });
});

describe('monthly budget', () => {
  const usage = (plan: number, officeLimitUsd: number | null) =>
    new AssistantUsageService(
      { assistantUsage: { findUnique: vi.fn(async () => ({ costMicros: 2_500_000n, requests: 40 })) } } as any,
      { get: vi.fn(async () => ({ enforced: true, limits: { assistantMonthlyBudgetMicros: plan } })) } as any,
      { get: vi.fn(async () => ({ enabled: true, monthlyLimitUsd: officeLimitUsd, voiceEnabled: true })) } as any,
    );

  it("is the plan's allowance, or the office's own limit when that is lower", async () => {
    expect(await usage(20_000_000, null).summary(ORG)).toMatchObject({ budgetMicros: 20_000_000, planBudgetMicros: 20_000_000, officeLimitMicros: null, usedMicros: 2_500_000, requests: 40 });
    expect((await usage(20_000_000, 5).summary(ORG)).budgetMicros).toBe(5_000_000);
    // A limit above the plan cannot raise it.
    expect((await usage(20_000_000, 50).summary(ORG)).budgetMicros).toBe(20_000_000);
  });

  it("stops new questions once the office's limit is used", async () => {
    await expect(usage(20_000_000, 2).assertWithinBudget(ORG)).rejects.toMatchObject({ code: 'ASSISTANT_BUDGET_EXCEEDED' });
  });
});

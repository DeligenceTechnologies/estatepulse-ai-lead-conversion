import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupController } from '@/followup/followup.controller';
import { CalendarConnectionController } from '@/calendar/connection/calendar-connection.controller';
import { FEATURES } from '../billing-plans';
import { makeConfig, ORG_A, ORG_B } from '../billing-fakes.test';
import type { BillingEnv } from '../billing.config';
import { EntitlementService } from './entitlement.service';
import { EntitlementGuard, FEATURE_KEY } from './require-feature.decorator';

type Sub = { orgId: string; plan: string; status: string; pastDueSince: Date | null };

function setup(subs: Sub[], members: Record<string, number>, env: Partial<BillingEnv> = { BILLING_ENFORCEMENT_ENABLED: true }) {
  const prisma = {
    subscription: { findUnique: vi.fn(async ({ where }: { where: { orgId: string } }) => subs.find((s) => s.orgId === where.orgId) ?? null) },
    user: { count: vi.fn(async ({ where }: { where: { orgId: string } }) => members[where.orgId] ?? 0) },
  };
  return new EntitlementService(prisma as unknown as PrismaService, makeConfig(env));
}

const response = (e: unknown) => (e as { getResponse(): { error: Record<string, unknown> } }).getResponse().error;
async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('EntitlementService', () => {
  it('gives an organization without a subscription the free plan', async () => {
    const e = await setup([], {}).get(ORG_A);
    expect(e.access.plan).toBe('FREE');
    expect(e.limits.maxMembers).toBe(1);
    expect(e.features).not.toContain(FEATURES.LEAD_AUTOMATION);
  });

  it('blocks a Professional feature on Starter with PLAN_UPGRADE_REQUIRED', async () => {
    const service = setup([{ orgId: ORG_A, plan: 'STARTER', status: 'active', pastDueSince: null }], {});
    const error = await rejection(service.assertFeature(ORG_A, FEATURES.LEAD_AUTOMATION));
    expect((error as { getStatus(): number }).getStatus()).toBe(403);
    expect(response(error)).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', requiredPlan: 'PROFESSIONAL', currentPlan: 'STARTER' });
    await expect(service.assertFeature(ORG_A, FEATURES.BASIC_DASHBOARD)).resolves.toBeUndefined();
  });

  it('does not grant paid features on an incomplete (unpaid) subscription', async () => {
    const service = setup([{ orgId: ORG_A, plan: 'BUSINESS', status: 'incomplete', pastDueSince: null }], {});
    expect(await service.hasFeature(ORG_A, FEATURES.LEAD_AUTOMATION)).toBe(false);
  });

  it('enforces the member limit, and names the plan that would fit', async () => {
    const service = setup([{ orgId: ORG_A, plan: 'STARTER', status: 'active', pastDueSince: null }], { [ORG_A]: 3 });
    const error = await rejection(service.assertCanAddMembers(ORG_A));
    expect(response(error)).toMatchObject({ code: 'PLAN_LIMIT_REACHED', used: 3, max: 3, requiredPlan: 'PROFESSIONAL' });
  });

  it('lets a member in under the limit', async () => {
    const service = setup([{ orgId: ORG_A, plan: 'STARTER', status: 'active', pastDueSince: null }], { [ORG_A]: 2 });
    await expect(service.assertCanAddMembers(ORG_A)).resolves.toBeUndefined();
  });

  it('reads each organization’s own plan only', async () => {
    const service = setup(
      [
        { orgId: ORG_A, plan: 'FREE', status: 'active', pastDueSince: null },
        { orgId: ORG_B, plan: 'BUSINESS', status: 'active', pastDueSince: null },
      ],
      { [ORG_A]: 1, [ORG_B]: 1 },
    );
    expect(await service.hasFeature(ORG_B, FEATURES.ADVANCED_REPORTING)).toBe(true);
    expect(await service.hasFeature(ORG_A, FEATURES.ADVANCED_REPORTING)).toBe(false);
    await expect(service.assertCanAddMembers(ORG_A)).rejects.toBeDefined();
  });

  it('only logs, never blocks, while enforcement is off', async () => {
    const service = setup([], { [ORG_A]: 5 }, { BILLING_ENFORCEMENT_ENABLED: false });
    await expect(service.assertCanAddMembers(ORG_A)).resolves.toBeUndefined();
    await expect(service.assertFeature(ORG_A, FEATURES.LEAD_AUTOMATION)).resolves.toBeUndefined();
  });
});

describe('@RequireFeature on existing routes', () => {
  const reflector = new Reflector();
  const featureOf = (method: (...args: never[]) => unknown) => reflector.get(FEATURE_KEY, method);

  it('gates automation and calendar connection, and leaves reads and disconnects open', () => {
    expect(featureOf(FollowupController.prototype.create)).toBe(FEATURES.LEAD_AUTOMATION);
    expect(featureOf(FollowupController.prototype.replaceSteps)).toBe(FEATURES.LEAD_AUTOMATION);
    expect(featureOf(FollowupController.prototype.list)).toBeUndefined();
    expect(featureOf(CalendarConnectionController.prototype.status)).toBeUndefined();
  });

  it('the guard checks the session’s organization', async () => {
    const service = setup([{ orgId: ORG_A, plan: 'STARTER', status: 'active', pastDueSince: null }], {});
    const guard = new EntitlementGuard(reflector, service);
    const context = {
      getHandler: () => FollowupController.prototype.create,
      getClass: () => FollowupController,
      switchToHttp: () => ({ getRequest: () => ({ auth: { organizationId: ORG_A } }) }),
    } as unknown as ExecutionContext;
    const error = await rejection(guard.canActivate(context));
    expect(response(error).code).toBe('PLAN_UPGRADE_REQUIRED');
  });
});

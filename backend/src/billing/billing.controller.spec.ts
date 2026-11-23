import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '@/auth/auth.constants';
import { PermissionsGuard } from '@/role/guards/permissions.guard';
import { effectivePermissions, PERMISSIONS } from '@/role/permissions';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { auth, ORG_A, ORG_B } from './billing-fakes.test';

/** Who may reach which billing route, with the app's real PermissionsGuard. */
const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);

function allowed(method: keyof BillingController, permissions: string[]): boolean {
  const context = {
    getHandler: () => BillingController.prototype[method],
    getClass: () => BillingController,
    switchToHttp: () => ({ getRequest: () => ({ auth: { ...auth(), permissions } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch {
    return false;
  }
}

const OWNER = effectivePermissions([{ isSystem: true, permissions: [] }]);
const AGENT = effectivePermissions([{ isSystem: false, permissions: [] }]);
const VIEWER = [PERMISSIONS.BILLING_READ];

describe('billing route permissions', () => {
  it('lets the owner do everything', () => {
    for (const m of ['subscription', 'usage', 'invoices', 'createCheckout', 'createPortal', 'changePlan', 'cancel', 'reactivate'] as const) {
      expect(allowed(m, OWNER)).toBe(true);
    }
  });

  it('keeps an agent out of billing entirely', () => {
    for (const m of ['subscription', 'invoices', 'createCheckout', 'createPortal', 'cancel'] as const) {
      expect(allowed(m, AGENT)).toBe(false);
    }
  });

  it('lets billing.read look but not pay, cancel or open the portal', () => {
    expect(allowed('subscription', VIEWER)).toBe(true);
    expect(allowed('invoices', VIEWER)).toBe(true);
    expect(allowed('createCheckout', VIEWER)).toBe(false);
    expect(allowed('createPortal', VIEWER)).toBe(false);
    expect(allowed('cancel', VIEWER)).toBe(false);
  });

  it('makes only the plan list and the (signature-checked) webhook public', () => {
    expect(reflector.get(IS_PUBLIC_KEY, BillingController.prototype.plans)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, BillingController.prototype.createCheckout)).toBeUndefined();
    expect(reflector.get(IS_PUBLIC_KEY, BillingWebhookController)).toBe(true);
  });
});

describe('billing routes act on the session’s organization only', () => {
  it('passes the authenticated organization, never one from the request', async () => {
    const billing = { subscription: vi.fn(), usage: vi.fn(), invoices: vi.fn() };
    const checkout = { createCheckout: vi.fn(), checkoutStatus: vi.fn() };
    const portal = { createPortalSession: vi.fn() };
    const subscriptions = { changePlan: vi.fn(), cancel: vi.fn(), reactivate: vi.fn() };
    const controller = new BillingController(billing as never, checkout as never, portal as never, subscriptions as never);

    const session = auth(ORG_A);
    // Even if a body somehow carried another organization, it is not read.
    controller.createCheckout(session, { plan: 'PROFESSIONAL', interval: 'MONTHLY', organizationId: ORG_B } as never);
    controller.subscription(session);
    controller.invoices(session, { organizationId: ORG_B });
    controller.cancel(session, {});

    expect(checkout.createCheckout).toHaveBeenCalledWith(session, 'PROFESSIONAL', 'MONTHLY');
    expect(billing.subscription).toHaveBeenCalledWith(ORG_A);
    expect(billing.invoices.mock.calls[0][0]).toBe(ORG_A);
    expect(subscriptions.cancel).toHaveBeenCalledWith(session, false);
  });
});

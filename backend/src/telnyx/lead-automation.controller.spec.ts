import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PermissionsGuard } from '@/role/guards/permissions.guard';
import { PERMISSIONS } from '@/role/permissions';
import { LeadAutomationController } from './lead-automation.controller';

/** The quick actions need "Change lead status" and a lead the user can see. */

const ORG = 'org-1';
const LEAD = '2c1a7c3e-1c62-4c1e-9d3e-6b1b7a6f3c11';
const auth = (permissions: string[]): AuthContext => ({ organizationId: ORG, userId: 'user-1', sessionId: 's', roleIds: [], permissions: permissions as never });

/** Runs the real PermissionsGuard against a handler of the controller, as Nest would. */
function allowed(handler: 'setAutomation' | 'markBooked', a: AuthContext): boolean {
  const context = {
    getHandler: () => LeadAutomationController.prototype[handler],
    getClass: () => LeadAutomationController,
    switchToHttp: () => ({ getRequest: () => ({ auth: a }) }),
  };
  try {
    return new PermissionsGuard(new Reflector()).canActivate(context as never);
  } catch {
    return false;
  }
}

function setup(visible: boolean) {
  const engine = { setAutomationPaused: vi.fn(), markBooked: vi.fn() };
  const audit = { quietly: vi.fn() };
  const prisma = { lead: { findFirst: vi.fn().mockResolvedValue(visible ? { id: LEAD } : null) } };
  return { controller: new LeadAutomationController(engine as any, audit as any, prisma as any), engine, audit, prisma };
}

describe('LeadAutomationController permissions', () => {
  it.each(['setAutomation', 'markBooked'] as const)('%s needs lead.update: an agent without it is refused, one with it goes through', (handler) => {
    expect(allowed(handler, auth([PERMISSIONS.LEAD_READ]))).toBe(false);
    expect(allowed(handler, auth([]))).toBe(false);
    expect(allowed(handler, auth([PERMISSIONS.LEAD_UPDATE]))).toBe(true);
  });
});

describe('LeadAutomationController lead scope', () => {
  it('a lead the user cannot see (not theirs, or another organization) is not found, and nothing runs or is audited', async () => {
    const { controller, engine, audit, prisma } = setup(false);
    const agent = auth([PERMISSIONS.LEAD_UPDATE]);
    await expect(controller.setAutomation(agent, LEAD, { paused: true })).rejects.toThrow(/No such lead/);
    await expect(controller.markBooked(agent, LEAD, {})).rejects.toThrow(/No such lead/);
    // An agent who sees only their own leads is scoped to them; an owner (lead.read) sees the organization's.
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG, assignedToId: 'user-1' }, select: { id: true } });
    expect(engine.setAutomationPaused).not.toHaveBeenCalled();
    expect(engine.markBooked).not.toHaveBeenCalled();
    expect(audit.quietly).not.toHaveBeenCalled();
  });

  it('an owner acts on any lead of the organization, and it is audited', async () => {
    const { controller, engine, audit, prisma } = setup(true);
    const owner = auth([PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE]);
    await controller.setAutomation(owner, LEAD, { paused: true });
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG }, select: { id: true } });
    expect(engine.setAutomationPaused).toHaveBeenCalledWith(ORG, LEAD, true);
    expect(audit.quietly).toHaveBeenCalledWith(expect.objectContaining({ action: 'lead.automation_paused', entityId: LEAD }));
  });
});

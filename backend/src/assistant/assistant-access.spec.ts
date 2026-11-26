import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PermissionsGuard } from '@/role/guards/permissions.guard';
import { DEFAULT_ROLES, PERMISSION_GROUPS, PERMISSIONS } from '@/role/permissions';
import { AssistantController } from './assistant.controller';

/** Who gets through to each assistant route, through the real guard and the controller's decorators. */
const guard = new PermissionsGuard(new Reflector());
const user = (permissions: string[]): AuthContext => ({ userId: 'u', organizationId: 'o', sessionId: 's', roleIds: [], permissions });
const call = (route: keyof AssistantController, auth: AuthContext) => {
  const handler = AssistantController.prototype[route] as (...args: unknown[]) => unknown;
  const context = {
    getHandler: () => handler,
    getClass: () => AssistantController,
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch {
    return false;
  }
};

const CHAT_ROUTES = ['send', 'confirm', 'reject', 'list', 'thread', 'remove', 'stop', 'feed', 'progress', 'stopBulk'] as const;

describe('assistant.use', () => {
  it('a role without it cannot chat, approve, read chats or see the Activity panel', () => {
    const agent = user(['lead.read', 'lead.update']);
    for (const route of CHAT_ROUTES) expect(call(route, agent), route).toBe(false);
  });

  it('a role with it can use every chat route', () => {
    const agent = user(['assistant.use']);
    for (const route of CHAT_ROUTES) expect(call(route, agent), route).toBe(true);
  });

  it('status answers everyone, so the app knows to hide the assistant', () => {
    expect(call('status', user([]))).toBe(true);
  });

  it('the settings and the log stay for owners, whether or not they use the assistant', () => {
    expect(call('getSettings', user(['organization.read']))).toBe(true);
    expect(call('updateSettings', user(['organization.read']))).toBe(false);
    expect(call('updateSettings', user(['organization.update']))).toBe(true);
    expect(call('log', user(['assistant.use']))).toBe(false);
  });

  it('new offices give it to the Agent role, and it sits with assistant.bulk in its own Roles group', () => {
    expect(DEFAULT_ROLES.AGENT.permissions).toContain(PERMISSIONS.ASSISTANT_USE);
    const group = PERMISSION_GROUPS.find((g) => g.module === 'assistant');
    expect(group?.permissions.map((p) => p.key)).toEqual([PERMISSIONS.ASSISTANT_USE, PERMISSIONS.ASSISTANT_BULK]);
    // Not under AI and automation, where ticking it would also tick automation.read.
    expect(PERMISSION_GROUPS.find((g) => g.module === 'automation')?.permissions.map((p) => p.key)).not.toContain(PERMISSIONS.ASSISTANT_BULK);
  });
});

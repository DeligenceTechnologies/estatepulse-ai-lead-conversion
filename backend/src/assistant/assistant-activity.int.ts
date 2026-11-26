import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectedAppsService } from '@/integration/connected-apps.service';
import { AssistantActivityService } from './assistant-activity.service';

/**
 * The activity feed's queries against the real database (backend/.env): who sees which lead's
 * events, and the relation filters Prisma builds for them.
 * Run: npx vitest run -c vitest.integration.config.ts src/assistant/assistant-activity.int.ts
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const service = new AssistantActivityService(prisma, new ConnectedAppsService(prisma));

let orgId: string;
let owner: AuthContext;
let agent: AuthContext;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `activity-int ${randomUUID().slice(0, 8)}` } })).id;
  const user = (first: string) =>
    prisma.user.create({ data: { orgId, firstName: first, lastName: 'Test', email: `act-${randomUUID()}@example.test`, password: 'not-a-real-hash' } });
  const [o, a] = await Promise.all([user('Owner'), user('Agent')]);
  owner = { userId: o.id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions: ['lead.read', 'integration.read'] };
  agent = { userId: a.id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions: ['lead.update'] };
  const mine = await prisma.lead.create({ data: { orgId, firstName: 'Maria', lastName: 'Lopez', assignedToId: a.id } });
  const theirs = await prisma.lead.create({ data: { orgId, firstName: 'Raj', lastName: 'Mehta' } });
  const base = { orgId, source: 'strategy', actorType: 'system' as const };
  await prisma.leadEvent.createMany({
    data: [
      { ...base, leadId: mine.id, type: 'status_changed', fromStatus: 'contacting', toStatus: 'interested' },
      { ...base, leadId: theirs.id, type: 'opted_out' },
      // Routine and old: never shown.
      { ...base, leadId: theirs.id, type: 'status_changed', fromStatus: 'new', toStatus: 'contacting' },
      { ...base, leadId: mine.id, type: 'opted_out', createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    ],
  });
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe('activity feed on the real database', () => {
  it("the owner sees the office's last day", async () => {
    const feed = await service.feed(owner);
    expect(feed.items.map((i) => `${i.lead?.name}: ${i.text}`).sort()).toEqual(['Maria Lopez: is interested', 'Raj Mehta: asked not to be contacted']);
    expect(feed.alerts).toEqual([]);
  });

  it('an agent sees only their own lead', async () => {
    const feed = await service.feed(agent);
    expect(feed.items.map((i) => `${i.lead?.name}: ${i.text}`)).toEqual(['Maria Lopez: is interested']);
  });
});

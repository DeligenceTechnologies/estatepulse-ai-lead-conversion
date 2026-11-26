import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AssistantRetentionService } from './assistant-retention.service';

/**
 * Chat retention on the real database (backend/.env): an old chat goes with everything in it, a
 * recent one stays, and an old one whose bulk job is still running waits.
 * Run: npx vitest run -c vitest.integration.config.ts src/assistant/assistant-retention.int.ts
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const retention = new AssistantRetentionService(prisma);
const DAY = 86_400_000;

let orgId: string;
const ids = { old: '', recent: '', busy: '' };

async function chat(userId: string, daysAgo: number, bulkStatus?: string): Promise<string> {
  const at = new Date(Date.now() - daysAgo * DAY);
  const thread = await prisma.assistantThread.create({ data: { orgId, userId, title: `chat ${daysAgo}d`, lastMessageAt: at, createdAt: at } });
  const lead = await prisma.lead.create({ data: { orgId, firstName: 'Old', lastName: 'Lead' } });
  const message = await prisma.assistantMessage.create({ data: { orgId, threadId: thread.id, position: 0, role: 'assistant', content: [{ type: 'text', text: 'Old Lead [L1]' }] } });
  const action = await prisma.assistantAction.create({
    data: {
      orgId, userId, threadId: thread.id, messageId: message.id, toolUseId: `tu-${daysAgo}`, toolName: 'leads_outreach_pause', tier: 'write', input: {}, status: 'executed',
      bulkTotal: 1, bulkStatus: bulkStatus ?? 'done',
    },
  });
  await prisma.assistantActionItem.create({ data: { orgId, actionId: action.id, leadId: lead.id, position: 0 } });
  await prisma.assistantRef.create({ data: { orgId, threadId: thread.id, entityType: 'lead', entityId: lead.id, number: 1 } });
  await prisma.assistantFeedback.create({ data: { orgId, threadId: thread.id, messageId: message.id, rating: 'down', reason: 'wrong' } });
  return thread.id;
}

const left = async (threadId: string) => ({
  thread: await prisma.assistantThread.count({ where: { id: threadId } }),
  messages: await prisma.assistantMessage.count({ where: { threadId } }),
  actions: await prisma.assistantAction.count({ where: { threadId } }),
  items: await prisma.assistantActionItem.count({ where: { action: { threadId } } }),
  refs: await prisma.assistantRef.count({ where: { threadId } }),
  feedback: await prisma.assistantFeedback.count({ where: { threadId } }),
});

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `retention-int ${randomUUID().slice(0, 8)}` } })).id;
  const user = await prisma.user.create({ data: { orgId, firstName: 'Ret', lastName: 'Test', email: `retention-${randomUUID()}@example.test`, password: 'not-a-real-hash' } });
  ids.old = await chat(user.id, 100);
  ids.recent = await chat(user.id, 10);
  ids.busy = await chat(user.id, 120, 'running');
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe('chat retention on the real database', () => {
  it('deletes a chat with no message for 90 days, and everything in it', async () => {
    await retention.sweep();
    expect(await left(ids.old)).toEqual({ thread: 0, messages: 0, actions: 0, items: 0, refs: 0, feedback: 0 });
  });

  it('keeps a recent chat, and an old one whose bulk job is still running', async () => {
    expect(await left(ids.recent)).toEqual({ thread: 1, messages: 1, actions: 1, items: 1, refs: 1, feedback: 1 });
    expect((await left(ids.busy)).thread).toBe(1);
    // Once the job ends, the next sweep takes it.
    await prisma.assistantAction.updateMany({ where: { threadId: ids.busy }, data: { bulkStatus: 'done' } });
    await retention.sweep();
    expect((await left(ids.busy)).thread).toBe(0);
  });
});

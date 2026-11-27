import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupService } from '@/followup/followup.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { OutreachControlService } from './outreach-control.service';

/**
 * Pause and resume against the real database (backend/.env): the claim on the lead, the follow-up
 * enrolments, the timeline and audit rows, and who may reach which lead. The engine and the text
 * queue are stand-ins; what they are asked to do is checked.
 * Run: npx vitest run -c vitest.integration.config.ts src/telnyx/outreach-control.int.ts
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const state = new LeadStateService(prisma);
const followup = new FollowupService(prisma, { getStrategy: async () => ({ guardrails: {} }) } as never, state);
const engine = {
  isRunning: vi.fn(() => true),
  canResume: vi.fn(async () => true),
  canReachLeads: vi.fn(async () => true),
  pauseStrategy: vi.fn(() => true),
  resume: vi.fn(async () => true),
  enroll: vi.fn(async () => undefined),
};
const textBack = { restore: vi.fn(async () => undefined) };
const service = new OutreachControlService(prisma, engine as never, followup, textBack as never, state, new AuditService(prisma), { publish: vi.fn() } as never);

let orgId: string;
let admin: AuthContext;
let agent: AuthContext;
let otherAgent: AuthContext;
let leadId: string;
let enrollmentId: string;
const promised = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `outreach-control-int ${randomUUID().slice(0, 8)}` } })).id;
  const user = (first: string) =>
    prisma.user.create({ data: { orgId, firstName: first, lastName: 'Test', email: `oc-${randomUUID()}@example.test`, password: 'not-a-real-hash' } });
  const [a, b, c] = await Promise.all([user('Admin'), user('Agent'), user('Other')]);
  const auth = (id: string, permissions: string[]): AuthContext => ({ userId: id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions });
  admin = auth(a.id, ['lead.read', 'lead.update']);
  agent = auth(b.id, ['lead.update']);
  otherAgent = auth(c.id, ['lead.update']);
  const lead = await prisma.lead.create({
    data: {
      orgId,
      firstName: 'Maria',
      lastName: 'Lopez',
      phone: '(512) 555-0101',
      normalizedPhone: '+15125550101',
      timezone: 'America/Chicago',
      status: 'contacting',
      consentStatus: 'granted',
      firstContactAt: new Date(Date.now() - 60 * 60 * 1000),
      textBackAt: promised,
      assignedToId: b.id,
    },
  });
  leadId = lead.id;
  const sequence = await prisma.sequence.create({ data: { orgId, code: `oc-${randomUUID().slice(0, 8)}`, name: 'Nurture 30' } });
  enrollmentId = (await prisma.sequenceEnrollment.create({ data: { orgId, leadId, sequenceId: sequence.id, currentStep: 2, nextActionAt: new Date() } })).id;
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe('pause and resume on the real database', () => {
  it("another agent cannot reach the lead; its own agent can", async () => {
    await expect(service.pausePlan(otherAgent, leadId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.pausePlan(agent, leadId)).lines).toContain('Sequence "Nurture 30", at step 2');
  });

  it('a pause holds the lead, its sequence and the promised text, and remembers the text', async () => {
    await service.pause(agent, leadId, { source: 'agent', reason: 'On holiday' });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { automationPaused: true, textBackAt: true } });
    expect(lead).toEqual({ automationPaused: true, textBackAt: null });
    expect(await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollmentId }, select: { status: true, nextActionAt: true } })).toEqual({
      status: 'paused',
      nextActionAt: null,
    });
    const event = await prisma.leadEvent.findFirstOrThrow({ where: { leadId, type: 'outreach_paused' } });
    expect(event).toMatchObject({ source: 'agent', actorType: 'user', actorId: agent.userId, reason: 'On holiday', payload: { textBackAt: promised.toISOString(), sequences: 1 } });
    expect(await prisma.auditLog.count({ where: { orgId, action: 'lead.outreach_paused', entityId: leadId } })).toBe(1);
    expect(engine.pauseStrategy).toHaveBeenCalledWith(leadId);
  });

  it('the lead page shows who paused it and why, to an admin too', async () => {
    expect(await service.state(admin, leadId)).toMatchObject({ paused: true, pausedBy: 'Agent Test', reason: 'On holiday', canControl: true });
  });

  it('a second pause is refused', async () => {
    await expect(service.pause(admin, leadId, { source: 'agent' })).rejects.toThrow(/already paused/);
  });

  it('an admin resumes it: the sequence goes on, the text comes back, the strategy goes on', async () => {
    const result = await service.resume(admin, leadId, { source: 'assistant' });
    expect(result).toEqual({ strategy: 'continued', sequences: 1, textBackRestored: true });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { automationPaused: true } })).automationPaused).toBe(false);
    const enrollment = await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollmentId }, select: { status: true, nextActionAt: true, currentStep: true } });
    expect(enrollment).toMatchObject({ status: 'active', currentStep: 2 });
    expect(enrollment.nextActionAt).not.toBeNull();
    expect(textBack.restore).toHaveBeenCalledWith(orgId, leadId, promised);
    expect(engine.resume).toHaveBeenCalledWith(orgId, leadId);
    expect(await prisma.leadEvent.count({ where: { leadId, type: 'outreach_resumed', actorId: admin.userId } })).toBe(1);
    expect((await service.state(admin, leadId)).paused).toBe(false);
  });
});

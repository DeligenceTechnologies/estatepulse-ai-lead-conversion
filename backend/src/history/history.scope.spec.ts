import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PERMISSIONS } from '@/role/permissions';
import { HistoryService } from './history.service';

const ORG = 'org-1';
const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: [PERMISSIONS.LEAD_READ] };
const agent: AuthContext = { userId: 'agent-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: [] };

function setup(lead: { id: string } | null = { id: 'lead-1' }) {
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    lead: { findFirst: vi.fn(async () => lead) },
    message: { findMany: vi.fn(async () => []) },
  };
  return { service: new HistoryService(prisma as any, {} as any), prisma };
}

/** The SQL text and bound values of the one raw query the list ran (a tagged template, nested fragments flattened). */
const sqlOf = (prisma: ReturnType<typeof setup>['prisma']) => {
  const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
  const query = Prisma.sql(strings, ...values);
  return { sql: query.sql, values: query.values };
};

describe('conversation threads, scoped', () => {
  it("lists only the agent's own leads in 'mine', even for someone who may read every lead", async () => {
    const s = setup();
    await s.service.listConversations(owner, 50, undefined, 'mine');
    const { sql, values } = sqlOf(s.prisma);
    expect(sql).toContain('l.assigned_to_id = ');
    expect(values).toContain('owner-1');
    expect(values).toContain(ORG);
  });

  it('keeps the office-wide list whole for someone with lead.read', async () => {
    const s = setup();
    await s.service.listConversations(owner, 50);
    expect(sqlOf(s.prisma).sql).not.toContain('assigned_to_id');
  });

  it('limits an agent to their own leads on the office-wide list too', async () => {
    const s = setup();
    await s.service.listConversations(agent, 50);
    const { sql, values } = sqlOf(s.prisma);
    expect(sql).toContain('l.assigned_to_id = ');
    expect(values).toContain('agent-1');
  });

  it("opens a thread in 'mine' only for a lead assigned to the user, in their org", async () => {
    const s = setup();
    await s.service.listMessages(owner, 'lead-1', 'mine');
    expect(s.prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: 'lead-1', orgId: ORG, assignedToId: 'owner-1' },
      select: { id: true },
    });
  });

  it('answers not found for a lead that is not theirs, and reads no messages', async () => {
    const s = setup(null);
    await expect(s.service.listMessages(agent, 'someone-elses-lead', 'mine')).rejects.toThrow('No such conversation');
    expect(s.prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("reads the messages of the agent's own lead from their own org only", async () => {
    const s = setup();
    await s.service.listMessages(agent, 'lead-1', 'mine');
    expect(s.prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: ORG, leadId: 'lead-1', channel: 'sms' } }));
  });
});

import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentController } from '@/agent/agent.controller';
import type { AuthContext } from '@/auth/auth.types';
import { AppointmentsService } from '@/calendar/appointments/appointments.service';
import { LeadBookingController } from '@/calendar/booking/lead-booking.controller';
import { LeadBookingService } from '@/calendar/booking/lead-booking.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { HistoryController } from '@/history/history.controller';
import { HistoryService } from '@/history/history.service';
import { DuplicatesController } from '@/lead/duplicates/duplicates.controller';
import { LeadEditService } from '@/lead/lead-edit.service';
import { LeadTimezoneService } from '@/lead/lead-timezone.service';
import { LeadsController } from '@/lead/leads.controller';
import { ChatTakeoverService } from '@/telnyx/sms/chat-takeover.service';
import { OutreachControlService } from '@/telnyx/outreach-control.service';
import { PortalLeadsController } from '@/telnyx/portal.controller';

/**
 * Every HTTP route that takes a lead (or one of its calls or threads), called the way the route
 * calls its service, against the real database (backend/.env). For each route: an admin of another
 * office and an agent of the same office who does not hold the lead get NOT_FOUND; the lead's own
 * agent and an admin of its office get through. Permissions per route are the role guard's job and
 * are not exercised here; this is about which rows a request can reach.
 * Services whose effects leave the database (the engine, Telnyx, queues) are stand-ins.
 * Run: npx vitest run -c vitest.integration.config.ts src/lead/lead-routes-isolation.int.ts
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const fake = () => new Proxy({}, { get: () => vi.fn(async () => ({})) }) as any;

const engine = { setStatus: vi.fn(async () => true), enroll: vi.fn(async () => undefined), qualified: vi.fn(async () => undefined), canReachLeads: vi.fn(async () => true) };
const portal = new PortalLeadsController(prisma, engine as any, { getStrategy: async () => ({ name: 'S', steps: [], guardrails: {} }) } as any, fake());
const timezones = new LeadTimezoneService(prisma, fake(), fake(), fake());
const reviews = { approve: vi.fn(async () => ({ approved: true })) };
const leads = new LeadsController(prisma, fake(), fake(), timezones, reviews as any, new LeadEditService(prisma, fake(), fake(), fake(), timezones, fake()));
const history = new HistoryService(prisma, fake());
const agentApp = new AgentController(prisma, fake(), history, new ChatTakeoverService(prisma, fake(), fake(), fake(), fake(), fake(), fake(), fake(), fake()));
const duplicates = new DuplicatesController(prisma, fake(), fake());
const historyRoutes = new HistoryController(history);
const booking = new LeadBookingController(new LeadBookingService(prisma, { useActive: async () => ({ agent: null, provider: null, eventTypes: [], blocker: 'no_calendar' }) } as any, fake(), new AppointmentsService(prisma)));
const outreach = new OutreachControlService(prisma, { isRunning: () => false, canResume: async () => false } as any, fake(), fake(), fake(), fake(), fake());

const orgs: string[] = [];
let adminA: AuthContext;
let agentA: AuthContext;
let otherAgentA: AuthContext;
let adminB: AuthContext;
let leadId: string;
let callId: string;

beforeAll(async () => {
  const office = async (label: string) => {
    const org = await prisma.organization.create({ data: { name: `routes-int ${label} ${randomUUID().slice(0, 8)}` } });
    orgs.push(org.id);
    return org.id;
  };
  const [a, b] = [await office('A'), await office('B')];
  const user = (orgId: string, first: string) =>
    prisma.user.create({ data: { orgId, firstName: first, lastName: 'Test', email: `routes-${randomUUID()}@example.test`, password: 'not-a-real-hash' } });
  const [ua, ug, uo, ub] = await Promise.all([user(a, 'Admin'), user(a, 'Agent'), user(a, 'Other'), user(b, 'AdminB')]);
  const auth = (id: string, orgId: string, permissions: string[]): AuthContext => ({ userId: id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions });
  const all = ['lead.read', 'lead.update', 'lead.assign', 'lead.import'];
  adminA = auth(ua.id, a, all);
  agentA = auth(ug.id, a, ['lead.update']);
  otherAgentA = auth(uo.id, a, ['lead.update']);
  adminB = auth(ub.id, b, all);
  const lead = await prisma.lead.create({
    data: { orgId: a, firstName: 'Maria', lastName: 'Lopez', phone: '(512) 555-0101', normalizedPhone: '+15125550101', assignedToId: ug.id, needsReview: true, reviewReasons: ['Checked by hand'] },
  });
  leadId = lead.id;
  callId = (await prisma.call.create({ data: { orgId: a, leadId, provider: 'telnyx', status: 'completed' } })).id;
  await prisma.message.create({ data: { orgId: a, leadId, direction: 'inbound', channel: 'sms', senderType: 'lead', body: 'Hi', deliveryStatus: 'delivered' } });
});

afterAll(async () => {
  for (const id of orgs) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

type Route = [name: string, call: (auth: AuthContext) => Promise<unknown>];

/** Routes everyone who may see the lead can use: its agent and its office's admin. */
const routes = (): Route[] => [
  ['GET /leads/:id/memory', (u) => portal.memory(u, leadId)],
  ['PUT /leads/:id/memory/:key', (u) => portal.setAnswer(u, leadId, 'budget', { value: '500k' } as any)],
  ['POST /leads/:id/enroll', (u) => portal.enroll(u, leadId)],
  ['GET /leads/:id/flow', (u) => portal.flow(u, leadId)],
  ['PATCH /leads/:id/status', (u) => portal.setStatus(u, leadId, { status: 'interested' } as any)],
  ['POST /leads/:id/outcome', (u) => portal.outcome(u, leadId, { outcome: 'follow_up', summary: 'x' } as any)],
  ['POST /leads/:id/qualified', (u) => portal.qualified(u, leadId, { temperature: 'hot', summary: 'x' } as any)],
  ['GET /leads/:id/events', (u) => portal.events(u, leadId)],
  ['GET /leads/:id/outreach', (u) => outreach.state(u, leadId)],
  ['GET /leads/:id/booking-options', (u) => booking.options(u, leadId)],
  ['GET /leads/:id/appointments', (u) => booking.appointments(u, leadId)],
  ['GET /v1/leads/:id', (u) => leads.one(u, leadId)],
  ['POST /v1/leads/:id/review/approve', (u) => leads.approveReview(u, leadId)],
  ['PUT /v1/leads/:id/timezone', (u) => leads.setTimezone(u, leadId, { timezone: 'America/Chicago' } as any)],
  ['GET /v1/leads/:id/submissions', (u) => duplicates.submissions(u, leadId)],
  ['GET /v1/leads/:id/merges', (u) => duplicates.mergeHistory(u, leadId)],
  ['GET /v1/calls/:id', (u) => historyRoutes.getCall(u, callId)],
  ['GET /v1/conversations/:id/messages', (u) => historyRoutes.listMessages(u, leadId)],
];

describe('every lead route stays inside what the user may see', () => {
  it.each(routes())('%s: another office gets nothing', async (_name, call) => {
    await expect(call(adminB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(routes())("%s: an agent who does not hold the lead gets nothing", async (_name, call) => {
    await expect(call(otherAgentA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(routes())("%s: the lead's own agent gets through", async (_name, call) => {
    await expect(call(agentA)).resolves.toBeDefined();
  });

  it("an admin of the lead's office gets through", async () => {
    await expect(leads.one(adminA, leadId)).resolves.toBeDefined();
    await expect(portal.events(adminA, leadId)).resolves.toBeDefined();
  });

  it('a write refused for another agent never reached its service', async () => {
    engine.setStatus.mockClear();
    reviews.approve.mockClear();
    await expect(portal.setStatus(otherAgentA, leadId, { status: 'closed' } as any)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(leads.approveReview(otherAgentA, leadId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(engine.setStatus).not.toHaveBeenCalled();
    expect(reviews.approve).not.toHaveBeenCalled();
  });
});

describe("the agent app's own routes: only the agent's leads", () => {
  const mine: Route[] = [
    ['GET /agents/me/leads/:id', (u) => agentApp.lead(u, leadId)],
    ['GET /agents/me/leads/:id/messages', (u) => agentApp.messages(u, leadId)],
  ];
  it.each(mine)('%s: refused to an admin of another office and to another agent; open to the lead\'s agent', async (_name, call) => {
    await expect(call(adminB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(otherAgentA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(agentA)).resolves.toBeDefined();
  });

  it('taking over or texting a lead the agent does not hold is not found', async () => {
    await expect(agentApp.takeOver(otherAgentA, leadId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(agentApp.sendMessage(otherAgentA, leadId, { id: randomUUID(), body: 'Hi' } as any)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

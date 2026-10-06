import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events/events.module';
import { LeadsModule } from './leads.module';

/**
 * Integration suite for manual lead assignment, against the real database, in
 * the shape of agent-me.test.ts: emails namespaced per run, every row tracked
 * and torn down in after().
 *
 * Run with `npm run test:lead-assignment`.
 *
 * Covers both offices the feature exists for: a "Just me" owner assigning a
 * lead to themselves, and a team owner assigning and reassigning between
 * agents — plus the safety rules: one current assignment per lead under
 * concurrency, the lead cap, suspended agents and tenant isolation.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `leadassign-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

interface Res {
  status: number;
  body: unknown;
  text: string;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(base + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const text = await res.text();
  let body: unknown = {};
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // non-JSON response; the raw text is still asserted on
  }
  return { status: res.status, body, text };
}

const errCode = (res: Res): unknown =>
  ((res.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['code'];

const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

async function signupOwner(tag: string, org: string): Promise<{ token: string; userId: string; orgId: string }> {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: org },
  });
  assert.equal(res.status, 201, `signup(${tag}) failed: ${res.text}`);

  const user = asRecord(asRecord(res.body)['user']);
  const organization = asRecord(asRecord(res.body)['organization']);
  createdUserIds.push(user['id'] as string);
  createdOrgIds.push(organization['id'] as string);
  return {
    token: asRecord(res.body)['token'] as string,
    userId: user['id'] as string,
    orgId: organization['id'] as string,
  };
}

/** Creates an agent in `ownerToken`'s organization and signs them in. */
async function createAgent(
  ownerToken: string,
  tag: string,
): Promise<{ userId: string; token: string }> {
  const created = await call('POST', '/api/agents', {
    token: ownerToken,
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Ag', lastName: tag },
  });
  assert.equal(created.status, 201, `create agent(${tag}) failed: ${created.text}`);
  const userId = asRecord(created.body)['id'] as string;
  createdUserIds.push(userId);

  const login = await call('POST', '/api/auth/login', {
    body: { email: emailFor(tag), password: PASSWORD },
  });
  assert.equal(login.status, 200, login.text);
  return { userId, token: asRecord(login.body)['token'] as string };
}


let ownerA = { token: '', userId: '', orgId: '' };
let ownerB = { token: '', userId: '', orgId: '' };
let solo = { token: '', userId: '', orgId: '', profileId: '' };
let alice = { userId: '', token: '', profileId: '' };
let bob = { userId: '', token: '', profileId: '' };
let carol = { userId: '', token: '', profileId: '' };

async function profileIdOf(orgId: string, userId: string): Promise<string> {
  const p = await prisma.agent_profiles.findFirst({ where: { organization_id: orgId, user_id: userId }, select: { id: true } });
  assert.ok(p, 'expected an agent profile');
  return p.id;
}

async function makeLead(orgId: string): Promise<string> {
  const lead = await prisma.leads.create({
    data: { organization_id: orgId, status: 'new', first_name: 'Lead', last_name: RUN },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  return lead.id;
}

const assignVia = (token: string, leadId: string, agentId: string): Promise<Res> =>
  call('PUT', `/api/v1/leads/${leadId}/assignment`, { token, body: { agentId } });

const currentRows = (leadId: string) =>
  prisma.lead_assignments.findMany({ where: { lead_id: leadId, is_current: true } });

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, EventsModule, AgentsModule, LeadsModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');

  base = await app.getUrl();
  prisma = app.get(PrismaService);

  ownerA = await signupOwner('owner-a', `LeadAssign Test A ${RUN}`);
  ownerB = await signupOwner('owner-b', `LeadAssign Test B ${RUN}`);

  const s = await call('POST', '/api/auth/signup', {
    body: {
      email: emailFor('solo'),
      password: PASSWORD,
      firstName: 'Solo',
      lastName: 'Owner',
      organizationName: `LeadAssign Test Solo ${RUN}`,
      teamSize: 'solo',
    },
  });
  assert.equal(s.status, 201, s.text);
  const sb = asRecord(s.body);
  solo = {
    token: sb['token'] as string,
    userId: asRecord(sb['user'])['id'] as string,
    orgId: asRecord(sb['organization'])['id'] as string,
    profileId: sb['agentProfileId'] as string,
  };
  createdUserIds.push(solo.userId);
  createdOrgIds.push(solo.orgId);

  for (const [tag, set] of [
    ['alice', (v: typeof alice) => (alice = v)],
    ['bob', (v: typeof bob) => (bob = v)],
    ['carol', (v: typeof carol) => (carol = v)],
  ] as const) {
    const a = await createAgent(ownerA.token, tag);
    set({ ...a, profileId: await profileIdOf(ownerA.orgId, a.userId) });
  }
});

after(async () => {
  try {
    // Leads first: lead_assignments.agent_id is ON DELETE RESTRICT, and the
    // lead's cascade removes its assignments. domain_events has no foreign
    // key, so its rows are removed by aggregate id.
    if (createdLeadIds.length > 0) {
      await prisma.domain_events.deleteMany({ where: { aggregate_id: { in: createdLeadIds } } });
      await prisma.leads.deleteMany({ where: { id: { in: createdLeadIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    // Organizations with audit rows cannot be removed (the audit log is
    // immutable) — the same rule and the same handling as agent-me.test.ts.
    const audited =
      createdOrgIds.length === 0
        ? []
        : await prisma.audit_logs.findMany({
            where: { organization_id: { in: createdOrgIds } },
            select: { organization_id: true },
            distinct: ['organization_id'],
          });
    const auditedOrgIds = new Set(audited.map((row) => row.organization_id));
    const deletable = createdOrgIds.filter((id) => !auditedOrgIds.has(id));
    if (deletable.length > 0) await prisma.organizations.deleteMany({ where: { id: { in: deletable } } });

    assert.equal(await prisma.users.count({ where: { id: { in: createdUserIds } } }), 0);
    assert.equal(await prisma.leads.count({ where: { id: { in: createdLeadIds } } }), 0);
  } finally {
    await app.close();
  }
});

// --- access ------------------------------------------------------------------

test('assignment needs a signed-in owner', async () => {
  const leadId = await makeLead(ownerA.orgId);

  const anon = await call('PUT', `/api/v1/leads/${leadId}/assignment`, { body: { agentId: alice.profileId } });
  assert.equal(anon.status, 401, anon.text);

  const asAgent = await assignVia(alice.token, leadId, alice.profileId);
  assert.equal(asAgent.status, 403, asAgent.text);
  assert.equal((await currentRows(leadId)).length, 0);
});

test('malformed input is a 400 and writes nothing', async () => {
  const leadId = await makeLead(ownerA.orgId);
  for (const body of [{}, { agentId: 'not-a-uuid' }, { agentId: alice.profileId, assignmentType: 'geographic' }, { agentId: alice.profileId, organizationId: ownerB.orgId }]) {
    const res = await call('PUT', `/api/v1/leads/${leadId}/assignment`, { token: ownerA.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
  }
  const bad = await call('PUT', '/api/v1/leads/not-a-uuid/assignment', { token: ownerA.token, body: { agentId: alice.profileId } });
  assert.equal(bad.status, 400, bad.text);
  assert.equal((await currentRows(leadId)).length, 0);
});

// --- "Just me" ---------------------------------------------------------------

test('a "Just me" owner assigns a lead to themselves', async () => {
  const leadId = await makeLead(solo.orgId);

  const res = await assignVia(solo.token, leadId, solo.profileId);
  assert.equal(res.status, 200, res.text);
  const body = asRecord(res.body);
  assert.equal(body['changed'], true);
  assert.equal(body['assignmentType'], 'manual');
  assert.equal(asRecord(body['agent'])['id'], solo.profileId);

  const rows = await currentRows(leadId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agent_id, solo.profileId);
  assert.equal(rows[0]!.assignment_type, 'manual');

  // The pipeline shows it.
  const list = await call('GET', '/api/v1/leads', { token: solo.token });
  const listed = (list.body as Array<Record<string, unknown>>).find((l) => l['id'] === leadId)!;
  assert.equal(asRecord(listed['assignedAgent'])['name'], 'Solo Owner');

  // Reason and outbox, in the same transaction as the assignment.
  const audit = await prisma.audit_logs.findFirst({ where: { entity_id: leadId, action: 'lead.assigned' } });
  assert.equal(asRecord(audit?.payload)['reason'], 'Assigned manually by the owner');
  assert.equal(audit?.actor_id, solo.userId);
  const event = await prisma.domain_events.findFirst({ where: { aggregate_id: leadId, event_type: 'lead.assigned' } });
  assert.ok(event);
});

test('assigning the same agent again is a no-op, not a second row', async () => {
  const leadId = await makeLead(solo.orgId);
  await assignVia(solo.token, leadId, solo.profileId);

  const again = await assignVia(solo.token, leadId, solo.profileId);
  assert.equal(again.status, 200, again.text);
  assert.equal(asRecord(again.body)['changed'], false);
  assert.equal((await prisma.lead_assignments.count({ where: { lead_id: leadId } })), 1);
  assert.equal(await prisma.audit_logs.count({ where: { entity_id: leadId } }), 1);
});

// --- team --------------------------------------------------------------------

test('a team owner assigns, then reassigns, keeping the history', async () => {
  const leadId = await makeLead(ownerA.orgId);

  assert.equal((await assignVia(ownerA.token, leadId, alice.profileId)).status, 200);
  const re = await assignVia(ownerA.token, leadId, bob.profileId);
  assert.equal(re.status, 200, re.text);

  const all = await prisma.lead_assignments.findMany({ where: { lead_id: leadId }, orderBy: { assigned_at: 'asc' } });
  assert.equal(all.length, 2);
  assert.equal(all[0]!.agent_id, alice.profileId);
  assert.equal(all[0]!.is_current, false);
  assert.ok(all[0]!.unassigned_at);
  assert.equal(all[1]!.agent_id, bob.profileId);
  assert.equal(all[1]!.is_current, true);

  const audit = await prisma.audit_logs.findFirst({ where: { entity_id: leadId, action: 'lead.reassigned' } });
  assert.equal(asRecord(audit?.payload)['previousAgentId'], alice.profileId);

  // Bob now sees it in his own list; Alice does not.
  const bobs = await call('GET', '/api/agents/me/leads', { token: bob.token });
  assert.ok(JSON.stringify(bobs.body).includes(leadId), bobs.text);
  const alices = await call('GET', '/api/agents/me/leads', { token: alice.token });
  assert.ok(!JSON.stringify(alices.body).includes(leadId), alices.text);
});

test('concurrent assigns of one lead leave exactly one current assignment', async () => {
  const leadId = await makeLead(ownerA.orgId);

  const results = await Promise.all(
    [bob, carol, bob, carol, bob, carol].map((a) => assignVia(ownerA.token, leadId, a.profileId)),
  );
  for (const r of results) assert.equal(r.status, 200, r.text);

  assert.equal((await currentRows(leadId)).length, 1);
});

test('the lead cap is enforced, not overridden', async () => {
  const cap = await call('PATCH', `/api/agents/${carol.userId}`, { token: ownerA.token, body: { maxActiveLeads: 1 } });
  assert.equal(cap.status, 200, cap.text);
  // Carol may already hold one from the concurrency test; count what she has.
  const held = await prisma.lead_assignments.count({ where: { agent_id: carol.profileId, is_current: true } });

  if (held === 0) {
    const first = await makeLead(ownerA.orgId);
    assert.equal((await assignVia(ownerA.token, first, carol.profileId)).status, 200);
  }

  const over = await makeLead(ownerA.orgId);
  const res = await assignVia(ownerA.token, over, carol.profileId);
  assert.equal(res.status, 409, res.text);
  assert.equal(errCode(res), 'CONFLICT');
  assert.equal((await currentRows(over)).length, 0);
});

test('a suspended agent cannot be assigned', async () => {
  const leadId = await makeLead(ownerA.orgId);
  assert.equal((await call('PATCH', `/api/agents/${alice.userId}`, { token: ownerA.token, body: { status: 'suspended' } })).status, 200);
  try {
    const res = await assignVia(ownerA.token, leadId, alice.profileId);
    assert.equal(res.status, 409, res.text);
    assert.equal((await currentRows(leadId)).length, 0);
  } finally {
    await call('PATCH', `/api/agents/${alice.userId}`, { token: ownerA.token, body: { status: 'active' } });
  }
});

// --- isolation ---------------------------------------------------------------

test("an owner cannot touch another organization's lead or agent", async () => {
  const leadA = await makeLead(ownerA.orgId);

  // B's owner, A's lead: the same 404 as a lead that does not exist.
  const foreignLead = await assignVia(ownerB.token, leadA, bob.profileId);
  assert.equal(foreignLead.status, 404, foreignLead.text);

  // A's owner, A's lead, but the solo office's agent.
  const foreignAgent = await assignVia(ownerA.token, leadA, solo.profileId);
  assert.equal(foreignAgent.status, 404, foreignAgent.text);

  assert.equal((await currentRows(leadA)).length, 0);
});

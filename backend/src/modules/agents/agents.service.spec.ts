import { describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { AppError } from '../../common/errors';
import { OwnerGuard } from '../../common/guards/owner.guard';
import type { GuardedPrisma } from '../../prisma/prisma.service';
import { AgentsService } from './agents.service';
import { createAgentSchema, updateAgentSchema } from './schemas';

/**
 * Unit suite. The prisma double below is deliberately not a stub that returns
 * canned values: it is a tiny in-memory database that records the `where` of
 * every read and write, because the things worth pinning here are *which rows a
 * query could reach* and *which rows a creation leaves behind* — neither of
 * which a returns-a-fixed-object mock can show.
 *
 * The HTTP contract (401/403/404/409 and real cross-tenant isolation against
 * Postgres) is covered by agents.test.ts, which boots Nest against the real
 * database the way auth.test.ts does.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}
interface MemberRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  joined_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
interface ProfileRow {
  id: string;
  organization_id: string;
  user_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  timezone: string;
}

interface Tables {
  users: UserRow[];
  organization_members: MemberRow[];
  agent_profiles: ProfileRow[];
  agent_availability: unknown[];
  agent_territories: unknown[];
  audit_logs: Array<Record<string, unknown>>;
}

let seq = 0;
const nextId = (): string => `gen-${(seq += 1)}`;

/**
 * Builds the service over a fake client seeded with two organizations:
 * ORG_A (an owner and an agent) and ORG_B (an owner). Two tenants is the
 * minimum that can prove isolation — with one, every query trivially passes.
 */
function build(options: { failProfileCreate?: boolean } = {}) {
  const db: Tables = {
    users: [
      { id: OWNER_A, email: 'owner-a@example.test', password_hash: 'x', first_name: 'Ada', last_name: 'Owner', phone: null },
      { id: AGENT_A, email: 'agent-a@example.test', password_hash: 'x', first_name: 'Ann', last_name: 'Agent', phone: '512-555-0101' },
      { id: OWNER_B, email: 'owner-b@example.test', password_hash: 'x', first_name: 'Bob', last_name: 'Other', phone: null },
    ],
    organization_members: [
      { id: 'm-a-owner', organization_id: ORG_A, user_id: OWNER_A, role: 'owner', status: 'active', joined_at: new Date('2026-01-01'), created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
      { id: 'm-a-agent', organization_id: ORG_A, user_id: AGENT_A, role: 'agent', status: 'active', joined_at: new Date('2026-02-01'), created_at: new Date('2026-02-01'), updated_at: new Date('2026-02-01') },
      { id: 'm-b-owner', organization_id: ORG_B, user_id: OWNER_B, role: 'owner', status: 'active', joined_at: new Date('2026-01-01'), created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    ],
    agent_profiles: [],
    agent_availability: [],
    agent_territories: [],
    audit_logs: [],
  };

  /** Every `where` the service handed to a read or an update, in order. */
  const wheres: Array<{ op: string; where: Record<string, unknown> }> = [];

  const userOf = (id: string): UserRow => db.users.find((u) => u.id === id)!;

  /**
   * Mirrors the service's select: named columns only, plus the agent profile
   * scoped to the organization being queried. Nothing assigns leads or connects
   * calendars, so both counts are 0 — exactly as Postgres would answer.
   */
  const publicUser = (u: UserRow, organizationId: string) => ({
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    agent_profiles: db.agent_profiles
      .filter((p) => p.user_id === u.id && p.organization_id === organizationId)
      .map((p) => ({ timezone: p.timezone, _count: { calendar_connections: 0, lead_assignments: 0 } })),
  });

  const client = {
    organizations: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push({ op: 'organizations.findUnique', where });
        return where['id'] === ORG_A || where['id'] === ORG_B ? { timezone: 'America/New_York' } : null;
      },
    },
    organization_members: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push({ op: 'organization_members.findMany', where });
        return db.organization_members
          .filter((m) => m.organization_id === where['organization_id'])
          // The service asks for role desc, created_at asc; reproducing it here
          // is what lets the ordering assertion below mean anything.
          .sort((a, b) => b.role.localeCompare(a.role) || a.created_at.getTime() - b.created_at.getTime())
          .map((m) => ({
            role: m.role,
            status: m.status,
            joined_at: m.joined_at,
            created_at: m.created_at,
            users: publicUser(userOf(m.user_id), where['organization_id'] as string),
          }));
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push({ op: 'organization_members.findFirst', where });
        const m = db.organization_members.find(
          (r) => r.organization_id === where['organization_id'] && r.user_id === where['user_id'],
        );
        return m
          ? {
              id: m.id,
              role: m.role,
              status: m.status,
              joined_at: m.joined_at,
              created_at: m.created_at,
              users: publicUser(userOf(m.user_id), where['organization_id'] as string),
            }
          : null;
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        wheres.push({ op: 'organization_members.update', where });
        const m = db.organization_members.find((r) => r.id === where['id'])!;
        Object.assign(m, data);
        return { status: m.status };
      },
      create: async ({ data }: { data: MemberRow }) => {
        const row = { ...data, id: nextId(), created_at: new Date(), updated_at: new Date() };
        db.organization_members.push(row);
        return { role: row.role, status: row.status, joined_at: row.joined_at, created_at: row.created_at };
      },
    },
    users: {
      create: async ({ data }: { data: Omit<UserRow, 'id'> }) => {
        const row = { ...data, id: nextId() };
        db.users.push(row);
        const { agent_profiles: _ignored, ...scalars } = publicUser(row, '');
        return scalars;
      },
    },
    agent_profiles: {
      create: async ({ data }: { data: Omit<ProfileRow, 'id' | 'status' | 'timezone'> }) => {
        if (options.failProfileCreate) throw new Error('boom: agent_profiles insert failed');
        // timezone is a database default, so the fake supplies it the way
        // Postgres would rather than the service passing one.
        const row = { ...data, id: nextId(), status: 'available', timezone: 'America/Chicago' };
        db.agent_profiles.push(row);
        return { id: row.id, timezone: row.timezone };
      },
    },
    audit_logs: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.audit_logs.push(data);
        return data;
      },
    },
    // The lower(email) pre-check. Tagged-template call, so the email is
    // values[0] — parameterised, never interpolated into the SQL text.
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const email = String(values[0]);
      return db.users.filter((u) => u.email.toLowerCase() === email.toLowerCase()).map((u) => ({ id: u.id }));
    },
    /** Interactive transaction with real rollback: snapshot in, restore on throw. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = JSON.parse(JSON.stringify(db)) as Tables;
      try {
        return await fn(client);
      } catch (err) {
        db.users = snapshot.users.map((u) => ({ ...u }));
        db.organization_members = snapshot.organization_members.map((m) => ({
          ...m,
          joined_at: m.joined_at ? new Date(m.joined_at) : null,
          created_at: new Date(m.created_at),
          updated_at: new Date(m.updated_at),
        }));
        db.agent_profiles = snapshot.agent_profiles.map((p) => ({ ...p }));
        db.audit_logs = snapshot.audit_logs.map((a) => ({ ...a }));
        throw err;
      }
    },
  };

  return { service: new AgentsService(client as unknown as GuardedPrisma), db, wheres };
}

const VALID = {
  email: 'new.agent@example.test',
  password: 'correct-horse-battery-staple',
  firstName: 'Nia',
  lastName: 'Newton',
  phone: '512-555-0199',
};

// --- listing -----------------------------------------------------------------

describe('AgentsService.list', () => {
  it('returns only the calling organization members, owner first', async () => {
    const { service } = build();

    const roster = await service.list(ORG_A);

    expect(roster.map((m) => m.email)).toEqual(['owner-a@example.test', 'agent-a@example.test']);
    expect(roster[0].role).toBe('owner');
    // ORG_B's owner exists in the same table and must not appear.
    expect(roster.some((m) => m.email === 'owner-b@example.test')).toBe(false);
  });

  it('scopes the query by the organization it was given', async () => {
    const { service, wheres } = build();

    await service.list(ORG_B);

    // Every read the call made is scoped to ORG_B — the roster by
    // organization_id, the timezone lookup by the organization's own id.
    const roster = wheres.find((w) => w.op === 'organization_members.findMany')!;
    expect(roster.where['organization_id']).toBe(ORG_B);
    expect(wheres.find((w) => w.op === 'organizations.findUnique')!.where['id']).toBe(ORG_B);
  });

  it('falls back to the organization timezone for a member with no agent profile', async () => {
    const { service } = build();

    const roster = await service.list(ORG_A);
    const owner = roster.find((m) => m.role === 'owner')!;

    // Signup creates no agent_profiles row, so the owner has no profile of their
    // own and the organization's timezone is the only true answer.
    expect(owner.hasProfile).toBe(false);
    expect(owner.timezone).toBe('America/New_York');
  });

  it("uses the agent's own profile timezone once one exists", async () => {
    const { service } = build();
    await service.create(ORG_A, OWNER_A, VALID);

    const created = (await service.list(ORG_A)).find((m) => m.email === VALID.email)!;

    expect(created.hasProfile).toBe(true);
    expect(created.timezone).toBe('America/Chicago');
  });

  it('reports zero active leads and no calendar, because nothing writes those tables', async () => {
    const { service } = build();

    const roster = await service.list(ORG_A);

    for (const member of roster) {
      expect(member.activeLeads).toBe(0);
      expect(member.calendarConnected).toBe(false);
    }
  });

  it('reports membership start from joined_at', async () => {
    const { service } = build();

    const owner = (await service.list(ORG_A)).find((m) => m.role === 'owner')!;

    expect(owner.memberSince).toEqual(new Date('2026-01-01'));
  });

  it('never exposes a password hash or any unlisted column', async () => {
    const { service } = build();

    const roster = await service.list(ORG_A);

    expect(Object.keys(roster[0]).sort()).toEqual(
      [
        'activeLeads',
        'calendarConnected',
        'email',
        'firstName',
        'hasProfile',
        'id',
        'lastName',
        'memberSince',
        'phone',
        'role',
        'status',
        'timezone',
      ].sort(),
    );
    expect(JSON.stringify(roster)).not.toContain('password');
  });
});

// --- creation ----------------------------------------------------------------

describe('AgentsService.create', () => {
  it('creates user + membership + profile in the calling organization', async () => {
    const { service, db } = build();

    const created = await service.create(ORG_A, OWNER_A, VALID);

    const user = db.users.find((u) => u.email === VALID.email)!;
    const member = db.organization_members.find((m) => m.user_id === user.id)!;
    const profile = db.agent_profiles.find((p) => p.user_id === user.id)!;

    expect(created.id).toBe(user.id);
    expect(member.organization_id).toBe(ORG_A);
    expect(profile.organization_id).toBe(ORG_A);
    expect(profile.display_name).toBe('Nia Newton');
  });

  it('always writes role=agent and status=active, whatever the caller sent', async () => {
    const { service, db } = build();

    // The strict schema rejects a role field outright; this asserts the second
    // line of defence — the service does not read one even if it arrived.
    await service.create(ORG_A, OWNER_A, { ...VALID, role: 'owner', organizationId: ORG_B } as never);

    const user = db.users.find((u) => u.email === VALID.email)!;
    const member = db.organization_members.find((m) => m.user_id === user.id)!;
    expect(member.role).toBe('agent');
    expect(member.status).toBe('active');
    expect(member.organization_id).toBe(ORG_A);
  });

  it('creates no availability and no territory rows', async () => {
    const { service, db } = build();

    await service.create(ORG_A, OWNER_A, VALID);

    expect(db.agent_availability).toHaveLength(0);
    expect(db.agent_territories).toHaveLength(0);
  });

  it('stores the password as a bcrypt hash and never returns it', async () => {
    const { service, db } = build();

    const created = await service.create(ORG_A, OWNER_A, VALID);
    const user = db.users.find((u) => u.email === VALID.email)!;

    expect(user.password_hash).not.toBe(VALID.password);
    expect(user.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(await bcrypt.compare(VALID.password, user.password_hash!)).toBe(true);
    expect(JSON.stringify(created)).not.toContain(VALID.password);
    expect(JSON.stringify(created)).not.toContain(user.password_hash!);
  });

  it('rejects a duplicate email with a 409', async () => {
    const { service } = build();

    await expect(service.create(ORG_A, OWNER_A, { ...VALID, email: 'agent-a@example.test' })).rejects.toMatchObject({
      code: 'EMAIL_TAKEN',
      status: 409,
    });
  });

  it('treats email uniqueness as case-insensitive', async () => {
    const { service, db } = build();
    const before = db.users.length;

    // The schema lower-cases before this point; the service compares on
    // lower(email) regardless, which is what the database index does.
    await expect(service.create(ORG_A, OWNER_A, { ...VALID, email: 'Agent-A@Example.test' })).rejects.toBeInstanceOf(AppError);
    expect(db.users).toHaveLength(before);
  });

  it('rolls the whole creation back when a later step fails', async () => {
    const { service, db } = build({ failProfileCreate: true });
    const users = db.users.length;
    const members = db.organization_members.length;

    await expect(service.create(ORG_A, OWNER_A, VALID)).rejects.toThrow('agent_profiles insert failed');

    // No orphan user, and no membership for an account that no longer exists.
    expect(db.users).toHaveLength(users);
    expect(db.organization_members).toHaveLength(members);
    expect(db.agent_profiles).toHaveLength(0);
  });
});

// --- audit trail -------------------------------------------------------------

describe('audit logging', () => {
  it('records who created a member, without the password', async () => {
    const { service, db } = build();

    const created = await service.create(ORG_A, OWNER_A, {
      email: 'audited@example.test',
      password: 'correct horse battery staple',
      firstName: 'Aud',
      lastName: 'Ited',
    });

    const row = db.audit_logs.find((a) => a['action'] === 'member.created')!;
    expect(row).toBeDefined();
    expect(row['organization_id']).toBe(ORG_A);
    expect(row['actor_type']).toBe('user');
    expect(row['actor_id']).toBe(OWNER_A);
    expect(row['entity_type']).toBe('member');
    expect(row['entity_id']).toBe(created.id);
    // The one thing that must never reach an audit row.
    expect(JSON.stringify(row)).not.toContain('correct horse battery staple');
    expect(JSON.stringify(row)).not.toContain('password_hash');
  });

  it('leaves no audit row behind when the creation rolls back', async () => {
    const { service, db } = build({ failProfileCreate: true });

    await expect(
      service.create(ORG_A, OWNER_A, {
        email: 'rolled-back@example.test',
        password: 'correct horse battery staple',
        firstName: 'Roll',
        lastName: 'Back',
      }),
    ).rejects.toThrow();

    expect(db.audit_logs).toHaveLength(0);
  });

  it('records both directions of the status switch', async () => {
    const { service, db } = build();

    await service.setStatus(ORG_A, OWNER_A, AGENT_A, 'suspended');
    await service.setStatus(ORG_A, OWNER_A, AGENT_A, 'active');

    const actions = db.audit_logs.map((a) => a['action']);
    expect(actions).toEqual(['member.suspended', 'member.reactivated']);

    const suspended = db.audit_logs[0]!;
    expect(suspended['actor_id']).toBe(OWNER_A);
    expect(suspended['entity_id']).toBe(AGENT_A);
    expect(suspended['payload']).toMatchObject({ from: 'active', to: 'suspended' });
  });

  it('writes no audit row when the suspension is refused', async () => {
    const { service, db } = build();

    await expect(service.setStatus(ORG_A, OWNER_A, OWNER_A, 'suspended')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(db.audit_logs).toHaveLength(0);
  });
});

// --- suspension --------------------------------------------------------------

describe('AgentsService.setStatus', () => {
  it('sets the membership status to suspended and leaves the user intact', async () => {
    const { service, db } = build();

    const result = await service.setStatus(ORG_A, OWNER_A, AGENT_A, 'suspended');

    expect(result.status).toBe('suspended');
    expect(db.organization_members.find((m) => m.user_id === AGENT_A)!.status).toBe('suspended');
    // Nothing deleted: the user row is still there.
    expect(db.users.some((u) => u.id === AGENT_A)).toBe(true);
  });

  it('refuses to suspend the caller', async () => {
    const { service, db } = build();

    await expect(service.setStatus(ORG_A, OWNER_A, OWNER_A, 'suspended')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(db.organization_members.find((m) => m.user_id === OWNER_A)!.status).toBe('active');
  });

  it('refuses to suspend an organization owner', async () => {
    const { service } = build();
    // A second owner in ORG_A, so this is not merely the self-suspension rule.
    const { db } = build();
    db.organization_members.push({
      id: 'm-a-owner2',
      organization_id: ORG_A,
      user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      role: 'owner',
      status: 'active',
      joined_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    db.users.push({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      email: 'owner-a2@example.test',
      password_hash: 'x',
      first_name: 'Cyd',
      last_name: 'Owner',
      phone: null,
    });

    await expect(service.setStatus(ORG_A, AGENT_A, OWNER_A, 'suspended')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot reach a member of another organization', async () => {
    const { service, db } = build();

    // OWNER_B is a real, existing user — just not in ORG_A.
    await expect(service.setStatus(ORG_A, OWNER_A, OWNER_B, 'suspended')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(db.organization_members.find((m) => m.user_id === OWNER_B)!.status).toBe('active');
  });

  it('reinstates a suspended member, so a suspension is recoverable', async () => {
    const { service, db } = build();

    await service.setStatus(ORG_A, OWNER_A, AGENT_A, 'suspended');
    expect(db.organization_members.find((m) => m.user_id === AGENT_A)!.status).toBe('suspended');

    const result = await service.setStatus(ORG_A, OWNER_A, AGENT_A, 'active');

    expect(result.status).toBe('active');
    expect(db.organization_members.find((m) => m.user_id === AGENT_A)!.status).toBe('active');
  });

  it('scopes the lookup by the authenticated organization, not the target id', async () => {
    const { service, wheres } = build();

    await service.setStatus(ORG_A, OWNER_A, AGENT_A, 'suspended');

    const lookup = wheres.find((w) => w.op === 'organization_members.findFirst')!;
    expect(lookup.where['organization_id']).toBe(ORG_A);
    expect(lookup.where['user_id']).toBe(AGENT_A);
  });
});

// --- input contract ----------------------------------------------------------

describe('createAgentSchema', () => {
  it('accepts a well-formed agent and lower-cases the email', () => {
    const parsed = createAgentSchema.parse({ ...VALID, email: 'New.Agent@Example.TEST' });
    expect(parsed.email).toBe('new.agent@example.test');
  });

  it('rejects a role field outright', () => {
    expect(createAgentSchema.safeParse({ ...VALID, role: 'owner' }).success).toBe(false);
  });

  it('rejects a client-supplied organization id in either spelling', () => {
    expect(createAgentSchema.safeParse({ ...VALID, organizationId: ORG_B }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...VALID, organization_id: ORG_B }).success).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(createAgentSchema.safeParse({ ...VALID, email: 'not-an-email' }).success).toBe(false);
  });

  it('applies the same password policy as signup', () => {
    expect(createAgentSchema.safeParse({ ...VALID, password: 'short' }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...VALID, password: 'x'.repeat(73) }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...VALID, password: 'x'.repeat(8) }).success).toBe(true);
  });

  it('requires a first and last name', () => {
    expect(createAgentSchema.safeParse({ ...VALID, firstName: '  ' }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...VALID, lastName: '' }).success).toBe(false);
  });
});

describe('updateAgentSchema', () => {
  it('accepts suspended and active, and nothing else', () => {
    expect(updateAgentSchema.safeParse({ status: 'suspended' }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ status: 'active' }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ status: 'invited' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ status: 'suspended', role: 'owner' }).success).toBe(false);
  });
});

// --- authorization -----------------------------------------------------------

describe('OwnerGuard', () => {
  const contextFor = (auth: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ auth }) }) }) as never;

  it('lets an owner through', () => {
    expect(new OwnerGuard().canActivate(contextFor({ role: 'owner' }))).toBe(true);
  });

  it('rejects an agent with 403', () => {
    expect(() => new OwnerGuard().canActivate(contextFor({ role: 'agent' }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }) as Error,
    );
  });

  it('fails closed when no session was resolved', () => {
    expect(() => new OwnerGuard().canActivate(contextFor(undefined))).toThrow(AppError);
  });
});

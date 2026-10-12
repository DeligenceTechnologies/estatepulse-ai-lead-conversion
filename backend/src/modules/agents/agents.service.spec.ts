import { describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { OwnerGuard } from '../../common/guards/owner.guard';
import type { GuardedPrisma } from '../../prisma/prisma.service';
import type { MailService } from '../../mail/mail.service';
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
  title: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  timezone: string;
  max_active_leads: number;
  /** Which Calendly member this agent is; null until the roster links them. */
  calendly_user_uri?: string | null;
  /** The Cal.com equivalent. */
  cal_user_id?: number | null;
  /** Column default true, as in Postgres. */
  routing_enabled?: boolean;
}

interface Tables {
  users: UserRow[];
  organization_members: MemberRow[];
  agent_profiles: ProfileRow[];
  agent_availability: unknown[];
  agent_territories: unknown[];
  audit_logs: Array<Record<string, unknown>>;
  /** Office connections only (agent_id null); empty means none connected. */
  calendar_connections: Array<{ organization_id: string; provider: string }>;
}

let seq = 0;
const nextId = (): string => `gen-${(seq += 1)}`;

/**
 * Builds the service over a fake client seeded with two organizations:
 * ORG_A (an owner and an agent) and ORG_B (an owner). Two tenants is the
 * minimum that can prove isolation — with one, every query trivially passes.
 */
function build(
  options: {
    failProfileCreate?: boolean;
    /** Throw a P2002 from agent_profiles.create, as a lost double-click race would. */
    profileCreateRaces?: boolean;
    mailDisabled?: boolean;
    mailThrows?: boolean;
  } = {},
) {
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
    calendar_connections: [],
  };

  /** Every `where` the service handed to a read or an update, in order. */
  const wheres: Array<{ op: string; where: Record<string, unknown> }> = [];

  /** The concurrently-committed row a lost race leaves behind; see profileCreateRaces. */
  let raceWinner: ProfileRow | null = null;

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
      .map((p) => ({
        id: p.id,
        title: p.title,
        timezone: p.timezone,
        max_active_leads: p.max_active_leads,
        routing_enabled: p.routing_enabled ?? true,
        calendly_user_uri: p.calendly_user_uri ?? null,
        cal_user_id: p.cal_user_id ?? null,
        _count: { lead_assignments: 0 },
      })),
  });

  const client = {
    organizations: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push({ op: 'organizations.findUnique', where });
        if (where['id'] === ORG_A) return { timezone: 'America/New_York', name: 'Org A Realty' };
        if (where['id'] === ORG_B) return { timezone: 'America/New_York', name: 'Org B Realty' };
        return null;
      },
    },
    calendar_connections: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push({ op: 'calendar_connections.findFirst', where });
        const row = db.calendar_connections.find((c) => c.organization_id === where['organization_id']);
        return row ? { provider: row.provider } : null;
      },
    },
    organization_members: {
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
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        wheres.push({ op: 'users.update', where });
        const u = db.users.find((r) => r.id === where['id'])!;
        Object.assign(u, data);
        return { ...u };
      },
    },
    agent_profiles: {
      create: async ({
        data,
      }: {
        data: Omit<ProfileRow, 'id' | 'status' | 'title' | 'max_active_leads'> & {
          timezone?: string;
          title?: string | null;
          max_active_leads?: number;
        };
      }) => {
        if (options.failProfileCreate) throw new Error('boom: agent_profiles insert failed');
        if (options.profileCreateRaces) {
          // What the lost race looks like: another transaction committed the
          // same row first. Parked outside this transaction's snapshot so the
          // rollback below cannot undo someone else's commit.
          raceWinner = {
            ...(data as ProfileRow),
            id: nextId(),
            status: 'available',
            timezone: data.timezone ?? 'America/Chicago',
            title: null,
            max_active_leads: 25,
          };
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        // Honours supplied values and falls back to the column defaults the way
        // Postgres would - a fake that always answered the default could not
        // tell a service that passes one from a service that does not.
        const row: ProfileRow = {
          ...data,
          id: nextId(),
          status: 'available',
          timezone: data.timezone ?? 'America/Chicago',
          title: data.title ?? null,
          max_active_leads: data.max_active_leads ?? 25,
        };
        db.agent_profiles.push(row);
        return {
          id: row.id,
          title: row.title,
          timezone: row.timezone,
          max_active_leads: row.max_active_leads,
          routing_enabled: row.routing_enabled ?? true,
        };
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        wheres.push({ op: 'agent_profiles.update', where });
        const row = db.agent_profiles.find((r) => r.id === where['id'])!;
        Object.assign(row, data);
        return { ...row };
      },
    },
    audit_logs: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.audit_logs.push(data);
        return data;
      },
    },
    // Tagged-template calls, so every value arrives parameterised in `values`,
    // never interpolated into the SQL text.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The roster statement: members of one organization — narrowed to one
      // user by the optional `and m.user_id` fragment — each joined to their
      // user and LEFT joined to their profile in that same organization,
      // ordered role desc, created_at asc, id asc — answered as Postgres would.
      if (strings.join('?').includes('from organization_members m')) {
        const organizationId = values[0] as string;
        const userId = (values[1] as Prisma.Sql).values[0] as string | undefined;
        wheres.push({
          op: 'roster.$queryRaw',
          where: { organization_id: organizationId, ...(userId === undefined ? {} : { user_id: userId }) },
        });
        return db.organization_members
          .filter((m) => m.organization_id === organizationId && (userId === undefined || m.user_id === userId))
          .sort(
            (a, b) =>
              b.role.localeCompare(a.role) ||
              a.created_at.getTime() - b.created_at.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map((m) => {
            const u = userOf(m.user_id);
            const p = db.agent_profiles.find((r) => r.user_id === m.user_id && r.organization_id === organizationId);
            return {
              id: m.id,
              role: m.role,
              status: m.status,
              joined_at: m.joined_at,
              created_at: m.created_at,
              user_id: u.id,
              email: u.email,
              first_name: u.first_name,
              last_name: u.last_name,
              phone: u.phone,
              profile_id: p?.id ?? null,
              title: p ? p.title : null,
              timezone: p ? p.timezone : null,
              max_active_leads: p ? p.max_active_leads : null,
              routing_enabled: p ? (p.routing_enabled ?? true) : null,
              calendly_user_uri: p?.calendly_user_uri ?? null,
              cal_user_id: p?.cal_user_id ?? null,
              // Nothing assigns leads here, so the count is 0 — as in publicUser.
              active_leads: 0,
            };
          });
      }
      // The lower(email) pre-check: the email is values[0].
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
        if (raceWinner) {
          db.agent_profiles.push(raceWinner);
          raceWinner = null;
        }
        throw err;
      }
    },
  };

  /**
   * A stand-in mailer. Records what it was asked to send so the tests can assert
   * on the content, and can be told to fail so "the agent is still created when
   * the email does not go out" is a real assertion rather than a hope.
   */
  const sent: Array<Record<string, unknown>> = [];
  const mail = {
    enabled: !options.mailDisabled,
    sendAgentWelcome: async (input: Record<string, unknown>) => {
      if (options.mailThrows) throw new Error('boom: smtp exploded');
      if (options.mailDisabled) return { sent: false, reason: 'Email is not configured on this server' };
      sent.push(input);
      return { sent: true };
    },
  };

  return {
    service: new AgentsService(client as unknown as GuardedPrisma, mail as unknown as MailService),
    db,
    wheres,
    sent,
  };
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
    const roster = wheres.find((w) => w.op === 'roster.$queryRaw')!;
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
    // Deliberately not the organization's America/New_York: a profile timezone
    // that matched it could not show which of the two the roster read.
    await service.create(ORG_A, OWNER_A, { ...VALID, timezone: 'Asia/Kolkata' });

    const created = (await service.list(ORG_A)).find((m) => m.email === VALID.email)!;

    expect(created.hasProfile).toBe(true);
    expect(created.timezone).toBe('Asia/Kolkata');
  });

  it('reports zero active leads and no calendar, because nothing writes those tables', async () => {
    const { service } = build();

    const roster = await service.list(ORG_A);

    for (const member of roster) {
      expect(member.activeLeads).toBe(0);
      expect(member.calendarLinked).toBe(false);
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
        'calendarLinked',
        'email',
        'firstName',
        'hasProfile',
        'id',
        'lastName',
        'maxActiveLeads',
        'memberSince',
        'phone',
        'profileId',
        'role',
        'takingLeads',
        'title',
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

  it("stores the timezone the owner's browser detected", async () => {
    const { service, db } = build();

    const created = await service.create(ORG_A, OWNER_A, { ...VALID, timezone: 'Asia/Kolkata' });

    expect(created.timezone).toBe('Asia/Kolkata');
    expect(db.agent_profiles.find((p) => p.user_id === created.id)!.timezone).toBe('Asia/Kolkata');
  });

  it("inherits the organization's timezone when the client detected none", async () => {
    const { service, db } = build();

    // Never the America/Chicago column default: an org outside it would get a
    // roster whose agents all disagree with the organization they belong to.
    const created = await service.create(ORG_A, OWNER_A, VALID);

    expect(created.timezone).toBe('America/New_York');
    expect(db.agent_profiles.find((p) => p.user_id === created.id)!.timezone).toBe('America/New_York');
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

    const lookup = wheres.find((w) => w.op === 'roster.$queryRaw')!;
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

// --- editing an agent profile ------------------------------------------------

/**
 * AGENT_A is seeded WITHOUT an agent_profiles row and a freshly created agent
 * always has one, so the two fixtures below exercise both halves of
 * updateProfile: the ordinary update, and the backfill for a member whose
 * profile predates create() writing them.
 */
async function withProfile() {
  const built = build();
  const created = await built.service.create(ORG_A, OWNER_A, VALID);
  return { ...built, agentId: created.id };
}

describe('AgentsService.updateProfile', () => {
  it('persists every Phase 1 field to the column that owns it', async () => {
    const { service, db, agentId } = await withProfile();

    const updated = await service.updateProfile(ORG_A, OWNER_A, agentId, {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace.hopper@example.test',
      phone: '512-555-0123',
      title: 'Senior Listing Agent',
      timezone: 'America/New_York',
      maxActiveLeads: 40,
    });

    // The response says so...
    expect(updated.firstName).toBe('Grace');
    expect(updated.lastName).toBe('Hopper');
    expect(updated.email).toBe('grace.hopper@example.test');
    expect(updated.phone).toBe('512-555-0123');
    expect(updated.title).toBe('Senior Listing Agent');
    expect(updated.timezone).toBe('America/New_York');
    expect(updated.maxActiveLeads).toBe(40);

    // ...and so do the rows, split across the two tables that really hold them.
    const user = db.users.find((u) => u.id === agentId)!;
    expect(user.first_name).toBe('Grace');
    expect(user.last_name).toBe('Hopper');
    expect(user.email).toBe('grace.hopper@example.test');
    expect(user.phone).toBe('512-555-0123');

    const profile = db.agent_profiles.find((p) => p.user_id === agentId)!;
    expect(profile.title).toBe('Senior Listing Agent');
    expect(profile.timezone).toBe('America/New_York');
    expect(profile.max_active_leads).toBe(40);
  });

  it('leaves every field the request did not mention alone', async () => {
    const { service, db, agentId } = await withProfile();
    const before = { ...db.users.find((u) => u.id === agentId)! };

    // A title-only edit, which is the common case from the form.
    await service.updateProfile(ORG_A, OWNER_A, agentId, { title: 'Buyer Agent' });

    const after = db.users.find((u) => u.id === agentId)!;
    expect(after.first_name).toBe(before.first_name);
    expect(after.last_name).toBe(before.last_name);
    expect(after.email).toBe(before.email);
    expect(after.phone).toBe(before.phone);
    // The cap keeps its column default rather than being reset by an edit that
    // never mentioned it.
    expect(db.agent_profiles.find((p) => p.user_id === agentId)!.max_active_leads).toBe(25);
  });

  it('clears an optional field with null, which absent cannot express', async () => {
    const { service, db, agentId } = await withProfile();
    await service.updateProfile(ORG_A, OWNER_A, agentId, { title: 'Buyer Agent' });

    await service.updateProfile(ORG_A, OWNER_A, agentId, { phone: null, title: null });

    expect(db.users.find((u) => u.id === agentId)!.phone).toBeNull();
    expect(db.agent_profiles.find((p) => p.user_id === agentId)!.title).toBeNull();
  });

  it('treats an empty string as a clear, the way create() treats a blank phone', async () => {
    const { service, db, agentId } = await withProfile();

    await service.updateProfile(ORG_A, OWNER_A, agentId, { phone: '' });

    // '' would otherwise be stored and then render as a blank phone number that
    // looks like a value.
    expect(db.users.find((u) => u.id === agentId)!.phone).toBeNull();
  });

  it("keeps the agent profile's mirrored name, email and phone in step", async () => {
    const { service, db, agentId } = await withProfile();

    await service.updateProfile(ORG_A, OWNER_A, agentId, {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.test',
      phone: '512-555-0177',
    });

    // create() writes these copies; an edit that skipped them would leave the
    // profile disagreeing with the user row it was copied from.
    const profile = db.agent_profiles.find((p) => p.user_id === agentId)!;
    expect(profile.display_name).toBe('Grace Hopper');
    expect(profile.email).toBe('grace@example.test');
    expect(profile.phone).toBe('512-555-0177');
  });

  it('backfills a missing agent profile rather than dropping half the edit', async () => {
    // AGENT_A is seeded with a membership but no profile row.
    const { service, db } = build();
    expect(db.agent_profiles).toHaveLength(0);

    const updated = await service.updateProfile(ORG_A, OWNER_A, AGENT_A, {
      title: 'Listing Agent',
      timezone: 'Asia/Kolkata',
      maxActiveLeads: 10,
    });

    const profile = db.agent_profiles.find((p) => p.user_id === AGENT_A)!;
    expect(profile.organization_id).toBe(ORG_A);
    expect(profile.title).toBe('Listing Agent');
    expect(profile.timezone).toBe('Asia/Kolkata');
    expect(profile.max_active_leads).toBe(10);
    // The phone is carried over from the user row rather than blanked.
    expect(profile.phone).toBe('512-555-0101');
    expect(updated.hasProfile).toBe(true);
  });

  it('never changes role, membership status or organization', async () => {
    const { service, db, agentId } = await withProfile();
    const before = { ...db.organization_members.find((m) => m.user_id === agentId)! };

    await service.updateProfile(ORG_A, OWNER_A, agentId, { firstName: 'Grace', maxActiveLeads: 99 });

    const after = db.organization_members.find((m) => m.user_id === agentId)!;
    expect(after.role).toBe(before.role);
    expect(after.status).toBe(before.status);
    expect(after.organization_id).toBe(before.organization_id);
  });

  it('never rewrites the password hash', async () => {
    const { service, db, agentId } = await withProfile();
    const before = db.users.find((u) => u.id === agentId)!.password_hash;

    await service.updateProfile(ORG_A, OWNER_A, agentId, { firstName: 'Grace' });

    expect(db.users.find((u) => u.id === agentId)!.password_hash).toBe(before);
  });

  it('cannot reach a member of another organization', async () => {
    const { service, db } = build();

    // ORG_B's owner, addressed by an ORG_A caller. A 404 rather than a 403: the
    // existence of an account in another tenant is not ours to confirm.
    await expect(service.updateProfile(ORG_A, OWNER_A, OWNER_B, { firstName: 'Mallory' })).rejects.toThrow(
      AppError,
    );
    expect(db.users.find((u) => u.id === OWNER_B)!.first_name).toBe('Bob');
  });

  it('scopes the lookup by the authenticated organization, not the target id', async () => {
    const { service, wheres, agentId } = await withProfile();

    await service.updateProfile(ORG_A, OWNER_A, agentId, { title: 'Buyer Agent' });

    const reads = wheres.filter((w) => w.op === 'roster.$queryRaw');
    // The read before the write and the re-read after it.
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.where).toEqual({ organization_id: ORG_A, user_id: agentId });
    }
  });

  it('refuses to edit an owner, who has no agent profile by design', async () => {
    const { service, db } = build();

    // Minting a profile for an owner as a side effect of a name change would
    // quietly turn the account into a routing target.
    await expect(service.updateProfile(ORG_A, OWNER_A, OWNER_A, { title: 'Broker' })).rejects.toThrow(
      AppError,
    );
    expect(db.agent_profiles).toHaveLength(0);
  });

  it('rejects an email another account already holds, case-insensitively', async () => {
    const { service, db, agentId } = await withProfile();

    await expect(
      service.updateProfile(ORG_A, OWNER_A, agentId, { email: 'OWNER-A@example.test' }),
    ).rejects.toThrow(AppError);
    expect(db.users.find((u) => u.id === agentId)!.email).toBe(VALID.email);
  });

  it("accepts a save that leaves the agent's own email unchanged", async () => {
    const { service, agentId } = await withProfile();

    // The pre-check has to exclude the target's own row, or re-saving the form
    // without touching the email would 409 against itself.
    const updated = await service.updateProfile(ORG_A, OWNER_A, agentId, {
      email: VALID.email,
      title: 'Buyer Agent',
    });

    expect(updated.email).toBe(VALID.email);
    expect(updated.title).toBe('Buyer Agent');
  });

  it('rolls the whole edit back when a later step fails', async () => {
    // AGENT_A has no profile, so the edit takes the backfill branch — and this
    // fake fails exactly that insert, after the users row has been written.
    const { service, db } = build({ failProfileCreate: true });

    await expect(
      service.updateProfile(ORG_A, OWNER_A, AGENT_A, { firstName: 'Grace', title: 'Broker' }),
    ).rejects.toThrow('boom');

    // A renamed user whose profile never arrived would be a half-applied edit.
    expect(db.users.find((u) => u.id === AGENT_A)!.first_name).toBe('Ann');
    expect(db.agent_profiles).toHaveLength(0);
    expect(db.audit_logs.some((a) => a['action'] === 'member.updated')).toBe(false);
  });

  it('records the edit, naming the fields changed but not their values', async () => {
    const { service, db, agentId } = await withProfile();

    await service.updateProfile(ORG_A, OWNER_A, agentId, {
      title: 'Broker',
      phone: '512-555-0144',
      maxActiveLeads: 12,
    });

    const entry = db.audit_logs.find((a) => a['action'] === 'member.updated')!;
    expect(entry['actor_id']).toBe(OWNER_A);
    expect(entry['actor_type']).toBe('user');
    expect(entry['entity_id']).toBe(agentId);
    expect(entry['organization_id']).toBe(ORG_A);
    expect((entry['payload'] as { changed: string[] }).changed.sort()).toEqual(
      ['maxActiveLeads', 'phone', 'title'].sort(),
    );
    // The phone number itself is not copied into the audit table.
    expect(JSON.stringify(entry['payload'])).not.toContain('512-555-0144');
  });

  it('records an email change from and to, because that is who can sign in', async () => {
    const { service, db, agentId } = await withProfile();

    await service.updateProfile(ORG_A, OWNER_A, agentId, { email: 'grace@example.test' });

    const entry = db.audit_logs.find((a) => a['action'] === 'member.updated')!;
    expect(entry['payload']).toMatchObject({
      email: { from: VALID.email, to: 'grace@example.test' },
    });
  });
});

// --- the update schema -------------------------------------------------------

describe('updateAgentSchema — profile fields', () => {
  it('accepts a profile-only edit and normalises the email', () => {
    const parsed = updateAgentSchema.parse({
      firstName: '  Grace ',
      email: 'Grace.Hopper@Example.Test',
      maxActiveLeads: 12,
    });

    expect(parsed).toEqual({ firstName: 'Grace', email: 'grace.hopper@example.test', maxActiveLeads: 12 });
  });

  it('still accepts the membership switch in both directions', () => {
    expect(updateAgentSchema.parse({ status: 'suspended' })).toEqual({ status: 'suspended' });
    expect(updateAgentSchema.parse({ status: 'active' })).toEqual({ status: 'active' });
  });

  it('rejects an empty body rather than answering 200 to a no-op', () => {
    expect(updateAgentSchema.safeParse({}).success).toBe(false);
  });

  it('refuses to mix the membership switch with a profile edit', () => {
    // They have different authorization rules, so a body doing both would have
    // to half-apply when one of them is refused.
    expect(updateAgentSchema.safeParse({ status: 'suspended', title: 'Broker' }).success).toBe(false);
  });

  it('rejects every field the client must not control', () => {
    for (const body of [
      { role: 'owner' },
      { organizationId: ORG_B },
      { organization_id: ORG_B },
      { password: 'correct-horse-battery-staple' },
      { routingEnabled: false },
      { routing_enabled: false },
      { agentStatus: 'available' },
      { firstName: 'Grace', role: 'owner' },
    ]) {
      expect(updateAgentSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('rejects an invalid email', () => {
    expect(updateAgentSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a timezone the runtime cannot name, rather than ignoring it', () => {
    // Unlike signup's browser-detected zone, this one was chosen on a form:
    // swallowing it would report a save that did not happen.
    expect(updateAgentSchema.safeParse({ timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ timezone: 'America/Chicago' }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ timezone: 'Asia/Kolkata' }).success).toBe(true);
  });

  it('enforces the max_active_leads > 0 check constraint at the edge', () => {
    // The database rejects 0; catching it here is the difference between a 400
    // and a 500.
    expect(updateAgentSchema.safeParse({ maxActiveLeads: 0 }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ maxActiveLeads: -1 }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ maxActiveLeads: 2.5 }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ maxActiveLeads: '10' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ maxActiveLeads: 1 }).success).toBe(true);
  });

  it('requires a non-empty name when one is supplied', () => {
    expect(updateAgentSchema.safeParse({ firstName: '   ' }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ lastName: '' }).success).toBe(false);
  });

  it('allows null for the two optional text fields, so they can be cleared', () => {
    expect(updateAgentSchema.safeParse({ phone: null }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ title: null }).success).toBe(true);
  });
});

// --- lead cap at onboarding --------------------------------------------------

describe('AgentsService.create — max active leads', () => {
  it('stores the cap the owner entered', async () => {
    const { service, db } = build();

    const created = await service.create(ORG_A, OWNER_A, { ...VALID, maxActiveLeads: 12 });

    expect(created.maxActiveLeads).toBe(12);
    expect(db.agent_profiles.find((p) => p.user_id === created.id)!.max_active_leads).toBe(12);
  });

  it('leaves the column default standing when the client sends none', async () => {
    const { service, db } = build();

    const created = await service.create(ORG_A, OWNER_A, VALID);

    expect(created.maxActiveLeads).toBe(25);
    expect(db.agent_profiles.find((p) => p.user_id === created.id)!.max_active_leads).toBe(25);
  });
});

describe('createAgentSchema — max active leads', () => {
  it('accepts a positive integer and stays optional', () => {
    expect(createAgentSchema.safeParse({ ...VALID, maxActiveLeads: 25 }).success).toBe(true);
    expect(createAgentSchema.safeParse(VALID).success).toBe(true);
  });

  it('applies the same rule as the edit form', () => {
    // agent_profiles has CHECK (max_active_leads > 0), so 0 is a 400 not a 500.
    for (const bad of [0, -1, 2.5, '10', null]) {
      expect(
        createAgentSchema.safeParse({ ...VALID, maxActiveLeads: bad }).success,
        String(bad),
      ).toBe(false);
    }
  });
});

// --- emailing the new agent their credentials --------------------------------

describe('AgentsService.create — credentials email', () => {
  it('emails the new agent the password the owner set', async () => {
    const { service, sent } = build();

    const created = await service.create(ORG_A, OWNER_A, VALID);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: VALID.email,
      firstName: VALID.firstName,
      password: VALID.password,
    });
    expect(created.credentialsEmail).toEqual({ sent: true, to: VALID.email });
  });

  it('names the organization the agent was added to', async () => {
    const { service, sent } = build();

    await service.create(ORG_A, OWNER_A, VALID);

    // Read back after the commit, so it is the office the rows actually landed
    // in rather than anything the request supplied.
    expect(sent[0]['organizationName']).toBe('Org A Realty');
  });

  it('creates the agent anyway when the mailer is switched off', async () => {
    const { service, db } = build({ mailDisabled: true });

    const created = await service.create(ORG_A, OWNER_A, VALID);

    // The account is the point; the email is how the password travels. Losing
    // the second must not lose the first.
    expect(db.users.some((u) => u.email === VALID.email)).toBe(true);
    expect(created.credentialsEmail.sent).toBe(false);
    expect(created.credentialsEmail.reason).toBeTruthy();
  });

  it('still answers 201 when the mailer throws unexpectedly', async () => {
    const { service, db } = build({ mailThrows: true });

    // The account is already committed by this point, so an exploding mailer
    // must not turn a created agent into a 500 — it turns into "not sent".
    const created = await service.create(ORG_A, OWNER_A, VALID);

    expect(db.users.some((u) => u.email === VALID.email)).toBe(true);
    expect(created.credentialsEmail.sent).toBe(false);
    expect(created.credentialsEmail.reason).toBeTruthy();
  });

  it('sends only after the write commits, so a rolled-back agent gets no email', async () => {
    const { service, sent } = build({ failProfileCreate: true });

    await expect(service.create(ORG_A, OWNER_A, VALID)).rejects.toThrow('boom');

    // An email naming an account that does not exist is worse than none.
    expect(sent).toHaveLength(0);
  });

  it('never returns the password or its hash to the caller', async () => {
    const { service } = build();

    const created = await service.create(ORG_A, OWNER_A, VALID);

    const body = JSON.stringify(created);
    expect(body).not.toContain(VALID.password);
    expect(body).not.toContain('password_hash');
    expect(body).not.toContain('$2b$');
  });

  it('reports delivery on the create response only, not on the roster', async () => {
    const { service } = build();
    await service.create(ORG_A, OWNER_A, VALID);

    const roster = await service.list(ORG_A);

    // Delivery is a fact about one request, not a property of a member.
    for (const member of roster) {
      expect(member).not.toHaveProperty('credentialsEmail');
    }
  });
});

// --- owner who also takes leads ---------------------------------------------

describe('AgentsService.setTakingLeads', () => {
  it("mints the owner's agent profile on first switch-on", async () => {
    const { service, db } = build();

    const me = await service.setTakingLeads(ORG_A, OWNER_A, true);

    const profiles = db.agent_profiles.filter((p) => p.user_id === OWNER_A);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].organization_id).toBe(ORG_A);
    expect(profiles[0].display_name).toBe('Ada Owner');
    // The login email, so a Calendly seat under the same address matches.
    expect(profiles[0].email).toBe('owner-a@example.test');
    // The organization's zone, not the US column default.
    expect(profiles[0].timezone).toBe('America/New_York');
    expect(me).toMatchObject({ role: 'owner', hasProfile: true, takingLeads: true, maxActiveLeads: 25 });
    expect(db.audit_logs.at(-1)).toMatchObject({
      action: 'member.routing_enabled',
      actor_id: OWNER_A,
      entity_id: OWNER_A,
      organization_id: ORG_A,
    });
  });

  it('is idempotent: switching on twice writes one profile and one audit row', async () => {
    const { service, db } = build();

    await service.setTakingLeads(ORG_A, OWNER_A, true);
    const again = await service.setTakingLeads(ORG_A, OWNER_A, true);

    expect(db.agent_profiles.filter((p) => p.user_id === OWNER_A)).toHaveLength(1);
    expect(db.audit_logs.filter((a) => a['action'] === 'member.routing_enabled')).toHaveLength(1);
    expect(again.takingLeads).toBe(true);
  });

  it('switching off keeps the profile and only stops new leads', async () => {
    const { service, db } = build();
    await service.setTakingLeads(ORG_A, OWNER_A, true);
    const profileId = db.agent_profiles.find((p) => p.user_id === OWNER_A)!.id;

    const off = await service.setTakingLeads(ORG_A, OWNER_A, false);

    const profile = db.agent_profiles.find((p) => p.user_id === OWNER_A)!;
    expect(profile.id).toBe(profileId);
    expect(profile.routing_enabled).toBe(false);
    expect(off).toMatchObject({ hasProfile: true, takingLeads: false });
    expect(db.audit_logs.at(-1)).toMatchObject({ action: 'member.routing_disabled' });
  });

  it('switching back on resumes the same profile rather than minting another', async () => {
    const { service, db } = build();
    await service.setTakingLeads(ORG_A, OWNER_A, true);
    const profileId = db.agent_profiles.find((p) => p.user_id === OWNER_A)!.id;
    await service.setTakingLeads(ORG_A, OWNER_A, false);

    const on = await service.setTakingLeads(ORG_A, OWNER_A, true);

    const profiles = db.agent_profiles.filter((p) => p.user_id === OWNER_A);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(profileId);
    expect(on.takingLeads).toBe(true);
  });

  it('switching off an owner who never took leads creates nothing', async () => {
    const { service, db } = build();

    const off = await service.setTakingLeads(ORG_A, OWNER_A, false);

    expect(db.agent_profiles).toHaveLength(0);
    expect(db.audit_logs).toHaveLength(0);
    expect(off).toMatchObject({ hasProfile: false, takingLeads: false });
  });

  it('refuses an agent, even though the switch would only touch themselves', async () => {
    const { service, db } = build();

    await expect(service.setTakingLeads(ORG_A, AGENT_A, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.agent_profiles).toHaveLength(0);
  });

  it("writes the profile in the caller's own organization only", async () => {
    const { service, db, wheres } = build();

    await service.setTakingLeads(ORG_B, OWNER_B, true);

    expect(db.agent_profiles).toHaveLength(1);
    expect(db.agent_profiles[0]).toMatchObject({ organization_id: ORG_B, user_id: OWNER_B });
    const reads = wheres.filter((w) => w.op === 'roster.$queryRaw');
    // The read before the write and the re-read after it.
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.where).toEqual({ organization_id: ORG_B, user_id: OWNER_B });
    }
  });

  it('treats a lost double-click race as success', async () => {
    const { service, db } = build({ profileCreateRaces: true });

    const me = await service.setTakingLeads(ORG_A, OWNER_A, true);

    expect(db.agent_profiles.filter((p) => p.user_id === OWNER_A)).toHaveLength(1);
    expect(me.takingLeads).toBe(true);
  });
});

describe('AgentsService.updateProfile — the owner who takes leads', () => {
  it('lets an owner edit their own profile once they take leads', async () => {
    const { service, db } = build();
    await service.setTakingLeads(ORG_A, OWNER_A, true);

    const updated = await service.updateProfile(ORG_A, OWNER_A, OWNER_A, {
      title: 'Broker',
      maxActiveLeads: 40,
      timezone: 'Asia/Kolkata',
    });

    const profile = db.agent_profiles.find((p) => p.user_id === OWNER_A)!;
    expect(profile).toMatchObject({ title: 'Broker', max_active_leads: 40, timezone: 'Asia/Kolkata' });
    expect(updated).toMatchObject({ role: 'owner', title: 'Broker', maxActiveLeads: 40 });
    // Still an owner: an edit never changes the role.
    expect(db.organization_members.find((m) => m.user_id === OWNER_A)!.role).toBe('owner');
  });

  it("never lets one owner edit another owner's profile", async () => {
    const { service, db } = build();
    const OWNER_A2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    db.users.push({ id: OWNER_A2, email: 'owner-a2@example.test', password_hash: 'x', first_name: 'Cy', last_name: 'Co', phone: null });
    db.organization_members.push({
      id: 'm-a-owner2',
      organization_id: ORG_A,
      user_id: OWNER_A2,
      role: 'owner',
      status: 'active',
      joined_at: new Date('2026-03-01'),
      created_at: new Date('2026-03-01'),
      updated_at: new Date('2026-03-01'),
    });
    await service.setTakingLeads(ORG_A, OWNER_A2, true);

    await expect(
      service.updateProfile(ORG_A, OWNER_A, OWNER_A2, { maxActiveLeads: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.agent_profiles.find((p) => p.user_id === OWNER_A2)!.max_active_leads).toBe(25);
  });
});

describe('AgentsService roster — calendarLinked follows the connected provider', () => {
  const linkedAgent = async (provider: string | null) => {
    const { service, db } = build();
    const created = await service.create(ORG_A, OWNER_A, VALID);
    Object.assign(db.agent_profiles.find((p) => p.user_id === created.id)!, {
      calendly_user_uri: 'https://api.calendly.com/users/ABC',
    });
    if (provider) db.calendar_connections.push({ organization_id: ORG_A, provider });
    return (await service.list(ORG_A)).find((m) => m.id === created.id)!;
  };

  it('is linked when the office is on Calendly and the agent has a Calendly member', async () => {
    expect((await linkedAgent('calendly')).calendarLinked).toBe(true);
  });

  it('is NOT linked by a leftover Calendly URI once the office is on Cal.com', async () => {
    expect((await linkedAgent('cal')).calendarLinked).toBe(false);
  });

  it('is not linked when the office has no calendar at all', async () => {
    expect((await linkedAgent(null)).calendarLinked).toBe(false);
  });
});

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

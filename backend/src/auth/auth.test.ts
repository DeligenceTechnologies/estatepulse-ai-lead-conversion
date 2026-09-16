import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../app.js';
import { prisma } from '../db.js';

/**
 * Integration suite against the real database. Every row it creates is torn
 * down in the after() hook; emails are namespaced per run so a crashed run
 * cannot collide with the next one.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `authtest-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let server: Server;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

/** Every response body seen by the suite, for the password_hash sweep. */
const allResponseBodies: string[] = [];

interface Res {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(base + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const text = await res.text();
  allResponseBodies.push(text);

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON response; body stays empty and the raw text is still asserted on
  }
  return { status: res.status, body, text };
}

const errCode = (res: Res): unknown => (res.body['error'] as Record<string, unknown> | undefined)?.['code'];

async function signupUser(tag: string, org: string, password: string = PASSWORD): Promise<{ token: string; userId: string; orgId: string }> {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor(tag), password, firstName: 'Test', lastName: 'User', organizationName: org },
  });
  assert.equal(res.status, 201, `signup(${tag}) failed: ${res.text}`);

  const user = res.body['user'] as { id: string };
  const organization = res.body['organization'] as { id: string };
  createdUserIds.push(user.id);
  createdOrgIds.push(organization.id);
  return { token: res.body['token'] as string, userId: user.id, orgId: organization.id };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (createdOrgIds.length > 0) {
    await prisma.organizations.deleteMany({ where: { id: { in: createdOrgIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// --- happy path -------------------------------------------------------------

let primaryToken = '';
let primaryUserId = '';

test('signup creates user + organization + owner membership', async () => {
  const res = await call('POST', '/api/auth/signup', {
    body: {
      email: emailFor('primary'),
      password: PASSWORD,
      firstName: 'Ada',
      lastName: 'Lovelace',
      organizationName: 'Austin Home Advisors Test',
    },
  });

  assert.equal(res.status, 201, res.text);
  const user = res.body['user'] as { id: string; email: string; firstName: string; lastName: string };
  const org = res.body['organization'] as { id: string; name: string; slug: string };

  createdUserIds.push(user.id);
  createdOrgIds.push(org.id);
  primaryToken = res.body['token'] as string;
  primaryUserId = user.id;

  assert.equal(typeof primaryToken, 'string');
  assert.ok(primaryToken.length > 0);
  assert.equal(user.email, emailFor('primary'));
  assert.equal(user.firstName, 'Ada');
  assert.equal(user.lastName, 'Lovelace');
  assert.equal(org.name, 'Austin Home Advisors Test');
  assert.ok(org.slug.startsWith('austin-home-advisors-test'));
  assert.equal(res.body['role'], 'owner');

  // all three rows exist, and exactly one membership, with role owner
  const members = await prisma.organization_members.findMany({
    where: { user_id: user.id },
    select: { role: true, status: true, organization_id: true },
  });
  assert.equal(members.length, 1);
  assert.equal(members[0]?.role, 'owner');
  assert.equal(members[0]?.status, 'active');
  assert.equal(members[0]?.organization_id, org.id);
});

test('signup does NOT create an agent_profiles row', async () => {
  const profiles = await prisma.agent_profiles.count({ where: { user_id: primaryUserId } });
  assert.equal(profiles, 0);
});

test('login with correct credentials returns a session', async () => {
  const res = await call('POST', '/api/auth/login', {
    body: { email: emailFor('primary'), password: PASSWORD },
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(typeof res.body['token'], 'string');
  assert.equal(res.body['role'], 'owner');
  assert.equal((res.body['user'] as { email: string }).email, emailFor('primary'));
});

test('login is case-insensitive on email', async () => {
  const res = await call('POST', '/api/auth/login', {
    body: { email: emailFor('primary').toUpperCase(), password: PASSWORD },
  });
  assert.equal(res.status, 200, res.text);
});

test('me returns user, organization, role and a null agentProfileId', async () => {
  const res = await call('GET', '/api/auth/me', { token: primaryToken });

  assert.equal(res.status, 200, res.text);
  assert.equal((res.body['user'] as { id: string }).id, primaryUserId);
  assert.equal(res.body['role'], 'owner');
  assert.equal(res.body['agentProfileId'], null);
  assert.equal(res.body['token'], undefined, 'me must not reissue a token');
});

// --- failure paths ----------------------------------------------------------

test('login with the wrong password returns INVALID_CREDENTIALS', async () => {
  const res = await call('POST', '/api/auth/login', {
    body: { email: emailFor('primary'), password: 'wrong-password-entirely' },
  });
  assert.equal(res.status, 401);
  assert.equal(errCode(res), 'INVALID_CREDENTIALS');
});

test('login with an unknown email returns the same INVALID_CREDENTIALS', async () => {
  const res = await call('POST', '/api/auth/login', {
    body: { email: emailFor('nobody'), password: PASSWORD },
  });
  assert.equal(res.status, 401);
  assert.equal(errCode(res), 'INVALID_CREDENTIALS');
});

test('duplicate signup returns EMAIL_TAKEN', async () => {
  const res = await call('POST', '/api/auth/signup', {
    body: {
      email: emailFor('primary'),
      password: PASSWORD,
      firstName: 'Ada',
      lastName: 'Lovelace',
      organizationName: 'Some Other Brokerage',
    },
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(errCode(res), 'EMAIL_TAKEN');
});

test('signup differing only in case returns EMAIL_TAKEN, not INTERNAL', async () => {
  const mixed = emailFor('primary').replace('authtest', 'AuthTest').toUpperCase();
  const res = await call('POST', '/api/auth/signup', {
    body: {
      email: mixed,
      password: PASSWORD,
      firstName: 'Ada',
      lastName: 'Lovelace',
      organizationName: 'Case Collision Brokerage',
    },
  });

  assert.equal(errCode(res), 'EMAIL_TAKEN', `expected EMAIL_TAKEN, got ${res.text}`);
  assert.equal(res.status, 409);
  assert.notEqual(errCode(res), 'INTERNAL');
});

test('me without a token returns UNAUTHENTICATED', async () => {
  const res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);
  assert.equal(errCode(res), 'UNAUTHENTICATED');
});

test('me with a garbage token returns UNAUTHENTICATED', async () => {
  const res = await call('GET', '/api/auth/me', { token: 'not.a.jwt' });
  assert.equal(res.status, 401);
  assert.equal(errCode(res), 'UNAUTHENTICATED');
});

test('a suspended membership returns NO_ORGANIZATION from me', async () => {
  const suspended = await signupUser('suspended', 'Suspended Brokerage');

  await prisma.organization_members.updateMany({
    where: { user_id: suspended.userId },
    data: { status: 'suspended' },
  });

  const res = await call('GET', '/api/auth/me', { token: suspended.token });
  assert.equal(res.status, 403, res.text);
  assert.equal(errCode(res), 'NO_ORGANIZATION');
  // must not leak that the account exists but is suspended
  assert.ok(!res.text.toLowerCase().includes('suspend'), 'response leaks suspension state');
});

test('an active membership is not shadowed by an older suspended one', async () => {
  const shadow = await signupUser('shadow', 'Shadow Brokerage One');

  // second org, active membership, created after the first
  const second = await prisma.organizations.create({
    data: { name: 'Shadow Brokerage Two', slug: `shadow-two-${RUN}` },
    select: { id: true },
  });
  createdOrgIds.push(second.id);
  await prisma.organization_members.create({
    data: {
      organization_id: second.id,
      user_id: shadow.userId,
      role: 'agent',
      status: 'active',
      joined_at: new Date(),
    },
    select: { id: true },
  });

  // suspend the original (older) membership
  await prisma.organization_members.updateMany({
    where: { user_id: shadow.userId, organization_id: shadow.orgId },
    data: { status: 'suspended' },
  });

  const res = await call('GET', '/api/auth/me', { token: shadow.token });
  assert.equal(res.status, 200, res.text);
  assert.equal((res.body['organization'] as { id: string }).id, second.id);
  assert.equal(res.body['role'], 'agent');
});

// --- users.status enforcement -----------------------------------------------

// One account, suspended at the users level after its token was issued. Both
// responses are captured so the third case can assert neither leaks why.
let suspendedUserToken = '';
let suspendedLoginBody = '';
let suspendedMeBody = '';

test('login as a user with status=suspended returns INVALID_CREDENTIALS', async () => {
  const user = await signupUser('userstatus', 'User Status Brokerage');
  suspendedUserToken = user.token;

  // token is valid right now
  const before = await call('GET', '/api/auth/me', { token: suspendedUserToken });
  assert.equal(before.status, 200, 'token should work before suspension');

  await prisma.users.update({ where: { id: user.userId }, data: { status: 'suspended' } });

  const res = await call('POST', '/api/auth/login', {
    body: { email: emailFor('userstatus'), password: PASSWORD },
  });
  suspendedLoginBody = res.text;

  assert.equal(res.status, 401, res.text);
  assert.equal(errCode(res), 'INVALID_CREDENTIALS');
});

test('me with a token issued before suspension returns UNAUTHENTICATED', async () => {
  const res = await call('GET', '/api/auth/me', { token: suspendedUserToken });
  suspendedMeBody = res.text;

  assert.equal(res.status, 401, res.text);
  assert.equal(errCode(res), 'UNAUTHENTICATED');
  // not NO_ORGANIZATION: the membership is still active, the user is not
  assert.notEqual(errCode(res), 'NO_ORGANIZATION');
});

test('neither suspended response body contains "suspend" or "inactive"', () => {
  assert.ok(suspendedLoginBody.length > 0, 'login body was not captured');
  assert.ok(suspendedMeBody.length > 0, 'me body was not captured');

  for (const [label, body] of [
    ['login', suspendedLoginBody],
    ['me', suspendedMeBody],
  ] as const) {
    const lower = body.toLowerCase();
    assert.ok(!lower.includes('suspend'), `${label} response leaks suspension state: ${body}`);
    assert.ok(!lower.includes('inactive'), `${label} response leaks account state: ${body}`);
    assert.ok(!lower.includes('invited'), `${label} response leaks account state: ${body}`);
  }
});

test('an invited user (no password set) cannot log in', async () => {
  const user = await signupUser('invited', 'Invited Brokerage');
  // invited is the state a seat sits in before its password exists
  await prisma.users.update({
    where: { id: user.userId },
    data: { status: 'invited', password_hash: null },
  });

  const res = await call('POST', '/api/auth/login', {
    body: { email: emailFor('invited'), password: PASSWORD },
  });
  assert.equal(res.status, 401, res.text);
  assert.equal(errCode(res), 'INVALID_CREDENTIALS');
});

test('unknown path returns NOT_FOUND, not INTERNAL', async () => {
  const res = await call('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(errCode(res), 'NOT_FOUND');
});

// --- validation -------------------------------------------------------------

// The minimum is 8, so these two pin the boundary from both sides.
test('signup with an 8-character password succeeds', async () => {
  await signupUser('minlen', 'Min Length Brokerage', '8charpw!');
});

test('signup with a 7-character password returns VALIDATION_ERROR with details', async () => {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor('short'), password: 'short12', firstName: 'A', lastName: 'B', organizationName: 'C' },
  });
  assert.equal(res.status, 400);
  assert.equal(errCode(res), 'VALIDATION_ERROR');
  const details = (res.body['error'] as { details: Array<{ path: string }> }).details;
  assert.ok(details.some((d) => d.path === 'password'));
});

test('signup missing firstName and lastName returns VALIDATION_ERROR', async () => {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor('nofields'), password: PASSWORD, organizationName: 'X' },
  });
  assert.equal(res.status, 400);
  assert.equal(errCode(res), 'VALIDATION_ERROR');
});

// --- the sweep --------------------------------------------------------------

test('password_hash appears in no response body', () => {
  assert.ok(allResponseBodies.length > 10, 'suite did not collect enough responses to be meaningful');

  for (const body of allResponseBodies) {
    assert.ok(!body.includes('password_hash'), `response leaked the password_hash key: ${body}`);
    assert.ok(!body.includes('passwordHash'), `response leaked a camelCase password hash: ${body}`);
    // a bcrypt hash in any form, under any key name
    assert.ok(!/\$2[aby]\$\d{2}\$/.test(body), `response leaked a bcrypt hash: ${body}`);
    assert.ok(!body.includes(PASSWORD), `response echoed the plaintext password: ${body}`);
  }
});

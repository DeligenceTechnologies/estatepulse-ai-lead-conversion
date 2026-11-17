import { describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { AirtableConnectionsService } from './airtable-connections.service';
import { AirtableApiError, SCOPES } from './types';

/**
 * Connecting, refreshing and disconnecting an Airtable account, with Prisma and
 * Airtable both stubbed — no database and no network, so these run anywhere.
 *
 * The behaviours pinned here are the ones that would lose data or leak across
 * organizations if they regressed.
 */

const WHO = { organizationId: 'org-1', userId: 'user-1', sessionId: 'sess-1' };
const GRANTED = [SCOPES.SCHEMA_READ, SCOPES.RECORDS_READ, SCOPES.RECORDS_WRITE];

/** A SecretBox stand-in whose output has the same shape, and which honours the AAD. */
const secrets = {
  seal: (plain: string, aad?: string) => `sealed(${plain})@${aad ?? ''}`,
  open: (sealed: string, aad?: string) => {
    const m = /^sealed\((.*)\)@(.*)$/.exec(sealed);
    if (!m || m[2] !== (aad ?? '')) throw new Error('bad seal');
    return m[1];
  },
};

function setup(
  over: {
    rows?: Record<string, unknown>[];
    identify?: () => Promise<unknown>;
    exchange?: () => Promise<unknown>;
    refresh?: () => Promise<unknown>;
  } = {},
) {
  const rows: Record<string, unknown>[] = over.rows ?? [];
  const updates: Record<string, unknown>[] = [];
  const integration = {
    findFirst: vi.fn(async ({ where }: any) =>
      rows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.orgId === undefined || r.orgId === where.orgId) &&
          (where.externalAccountId === undefined || r.externalAccountId === where.externalAccountId) &&
          (where.revokedAt === undefined || r.revokedAt === where.revokedAt),
      ) ?? null,
    ),
    findMany: vi.fn(async ({ where }: any) => rows.filter((r) => r.orgId === where.orgId && r.revokedAt === null)),
    create: vi.fn(async ({ data }: any) => {
      const row = { createdAt: new Date(), lastVerifiedAt: null, lastErrorCode: null, accountEmail: null, revokedAt: null, ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      updates.push({ where, data });
      const matched = rows.filter(
        (r) =>
          r.id === where.id &&
          (where.credentialHash === undefined || r.credentialHash === where.credentialHash) &&
          (where.status === undefined || r.status === where.status),
      );
      matched.forEach((r) => Object.assign(r, data));
      return { count: matched.length };
    }),
  };
  const prisma = { integration, $transaction: vi.fn(async (fn: any) => fn({ integration })) };
  const client = {
    isConfigured: () => true,
    missingRequiredRequests: () => [],
    requestedScopes: [...GRANTED, SCOPES.SCHEMA_WRITE],
    authorizeUrl: (state: string, challenge: string) => `https://airtable.com/oauth2/v1/authorize?state=${state}&code_challenge=${challenge}`,
    exchangeCode: vi.fn(over.exchange ?? (async () => ({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, refreshExpiresIn: 5_184_000, scopes: GRANTED }))),
    refresh: vi.fn(over.refresh ?? (async () => ({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 3600, refreshExpiresIn: 5_184_000, scopes: GRANTED }))),
    identify: vi.fn(over.identify ?? (async () => ({ userId: 'usr1', email: 'a@b.test', scopes: GRANTED }))),
  };
  const audit = { record: vi.fn(async (_entry: Record<string, unknown>) => undefined) };
  const alerts = { connectionBroken: vi.fn() };
  const service = new AirtableConnectionsService(prisma as any, client as any, secrets as any, audit as any, alerts as any);
  return { service, prisma, client, audit, alerts, rows, updates };
}

/** A state the service will accept, sealed exactly as sealState does. */
function sealedState(who = WHO, exp = Date.now() + 600_000) {
  const cv = randomBytes(32).toString('base64url');
  const payload = { v: 1, org: who.organizationId, usr: who.userId, sid: who.sessionId, nonce: randomBytes(16).toString('base64url'), exp, cv };
  return { state: secrets.seal(JSON.stringify(payload), 'airtable:oauth_state:v1'), cv };
}

describe('starting an Airtable authorization', () => {
  it('binds PKCE to the session: the challenge is the hash of the verifier sealed in the state', () => {
    const { service } = setup();

    const { authorizeUrl, state } = service.start(WHO);

    const challenge = new URL(authorizeUrl).searchParams.get('code_challenge')!;
    const payload = JSON.parse(secrets.open(state, 'airtable:oauth_state:v1')) as { cv: string; org: string };
    expect(payload.org).toBe('org-1');
    expect(challenge).toBe(createHash('sha256').update(payload.cv).digest('base64url'));
  });

  it('refuses to start when the server has no Airtable credentials', () => {
    const { service, client } = setup();
    client.isConfigured = () => false;
    expect(() => service.start(WHO)).toThrowError(
      expect.objectContaining({ response: { error: expect.objectContaining({ code: 'AIRTABLE_NOT_CONFIGURED' }) } }),
    );
  });
});

describe('completing an Airtable authorization', () => {
  it('stores the refresh token sealed to its own row and never returns it', async () => {
    const s = setup();
    const { state, cv } = sealedState();

    const dto = await s.service.complete(WHO, 'code-1', state);

    expect(s.client.exchangeCode).toHaveBeenCalledWith('code-1', cv);
    const row = s.rows[0];
    // Sealed to (organization, row id): the ciphertext cannot be moved to another row.
    expect(row.credentials).toBe(`sealed(rt)@org-1:${row.id}:integration`);
    expect(row.credentialHash).toBe(createHash('sha256').update('rt').digest('hex'));
    expect(JSON.stringify(dto)).not.toContain('rt');
    expect(dto.permissions).toMatchObject({ readRecords: true, writeRecords: true, writeSchema: false });
    // Asked for but not granted, so the card can say so and phase 4 stays shut.
    expect(dto.missingScopes).toEqual([SCOPES.SCHEMA_WRITE]);
  });

  it('refuses a grant that cannot read Airtable, rather than storing a half-working connection', async () => {
    const s = setup({ identify: async () => ({ userId: 'usr1', email: null, scopes: [SCOPES.RECORDS_READ] }) });

    await expect(s.service.complete(WHO, 'code-1', sealedState().state)).rejects.toMatchObject({ response: { error: { code: 'AIRTABLE_SCOPE_NOT_GRANTED' } } });
    expect(s.rows).toHaveLength(0);
  });

  it('reconnecting the same account updates its row instead of making a second one', async () => {
    const s = setup();
    await s.service.complete(WHO, 'code-1', sealedState().state);
    const firstId = s.rows[0].id;

    await s.service.complete(WHO, 'code-2', sealedState().state);

    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].id).toBe(firstId);
    expect(s.audit.record.mock.calls.map((c: any) => c[0].action)).toEqual(['airtable.connected', 'airtable.reconnected']);
  });

  it.each([
    ['a state from another session', { ...WHO, sessionId: 'other' }, Date.now() + 600_000, 'OAUTH_SESSION_MISMATCH'],
    ['a state from another organization', { ...WHO, organizationId: 'org-2' }, Date.now() + 600_000, 'OAUTH_SESSION_MISMATCH'],
    ['an expired state', WHO, Date.now() - 1, 'OAUTH_STATE_EXPIRED'],
  ])('refuses %s', async (_name, who, exp, code) => {
    const s = setup();
    await expect(s.service.complete(WHO, 'code-1', sealedState(who as typeof WHO, exp).state)).rejects.toMatchObject({
      response: { error: { code } },
    });
    expect(s.client.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a state that was already used, so a replayed code cannot connect twice', async () => {
    const s = setup();
    const { state } = sealedState();
    await s.service.complete(WHO, 'code-1', state);

    await expect(s.service.complete(WHO, 'code-1', state)).rejects.toMatchObject({ response: { error: { code: 'OAUTH_STATE_USED' } } });
  });

  it('turns a rejected authorization code into a plain "start again"', async () => {
    const s = setup({
      exchange: async () => {
        throw new AirtableApiError('REAUTH', 'invalid_grant', 400);
      },
    });
    await expect(s.service.complete(WHO, 'bad', sealedState().state)).rejects.toMatchObject({ response: { error: { code: 'OAUTH_CODE_REJECTED' } } });
  });
});

describe('access tokens', () => {
  const connected = () => [
    {
      id: 'int-1',
      orgId: 'org-1',
      provider: 'airtable',
      status: 'active',
      revokedAt: null,
      credentials: 'sealed(rt)@org-1:int-1:integration',
      credentialHash: createHash('sha256').update('rt').digest('hex'),
      config: { scopes: GRANTED, refreshExpiresAt: null },
      createdAt: new Date(),
    },
  ];

  it('refreshes, then stores the rotated token with a compare-and-swap on the old one', async () => {
    const s = setup({ rows: connected() });

    const token = await s.service.withAccessToken('org-1', 'int-1', async (t) => t);

    expect(token).toBe('at2');
    // Airtable invalidates the presented token immediately, so the newest must win:
    // the write is conditional on the hash of the token we actually presented.
    const write = s.updates.at(-1)!;
    expect((write.where as any).credentialHash).toBe(createHash('sha256').update('rt').digest('hex'));
    expect((write.data as any).credentialHash).toBe(createHash('sha256').update('rt2').digest('hex'));
    expect(s.rows[0].credentials).toBe('sealed(rt2)@org-1:int-1:integration');
  });

  it('caches the access token, so a second call does not refresh again', async () => {
    const s = setup({ rows: connected() });
    await s.service.withAccessToken('org-1', 'int-1', async (t) => t);
    await s.service.withAccessToken('org-1', 'int-1', async (t) => t);
    expect(s.client.refresh).toHaveBeenCalledOnce();
  });

  it('parks the connection when the grant is dead, and tells the owner', async () => {
    const s = setup({
      rows: connected(),
      refresh: async () => {
        throw new AirtableApiError('REAUTH', 'invalid_grant', 400);
      },
    });

    await expect(s.service.withAccessToken('org-1', 'int-1', async (t) => t)).rejects.toMatchObject({ kind: 'REAUTH' });
    expect(s.rows[0].status).toBe('invalid');
    expect(s.rows[0].lastErrorCode).toBe('AIRTABLE_REAUTH_REQUIRED');
    expect(s.alerts.connectionBroken).toHaveBeenCalledOnce();
  });

  it('never hands one organization another organization’s connection', async () => {
    const s = setup({ rows: connected() });

    await expect(s.service.withAccessToken('org-2', 'int-1', async (t) => t)).rejects.toMatchObject({ kind: 'REAUTH' });
    expect(s.client.refresh).not.toHaveBeenCalled();
    await expect(s.service.mustFind('org-2', 'int-1')).rejects.toMatchObject({ response: { error: { code: 'AIRTABLE_NOT_CONNECTED' } } });
  });

  it('refuses an empty connection id instead of matching any row in the organization', async () => {
    const s = setup({ rows: connected() });
    await expect(s.service.withAccessToken('org-1', '', async (t) => t)).rejects.toMatchObject({ kind: 'REAUTH' });
    expect(s.prisma.integration.findFirst).not.toHaveBeenCalled();
  });
});

describe('disconnecting', () => {
  it('forgets the grant and keeps the imported data', async () => {
    const s = setup();
    await s.service.complete(WHO, 'code-1', sealedState().state);

    await s.service.disconnect(WHO, String(s.rows[0].id));

    expect(s.rows[0]).toMatchObject({ status: 'revoked', credentials: '', credentialHash: null });
    expect(s.rows[0].revokedAt).toBeInstanceOf(Date);
    expect(s.audit.record.mock.calls.at(-1)![0]).toMatchObject({ action: 'airtable.disconnected' });
  });

  it('will not disconnect a connection belonging to another organization', async () => {
    const s = setup();
    await s.service.complete(WHO, 'code-1', sealedState().state);

    await expect(s.service.disconnect({ ...WHO, organizationId: 'org-2' }, String(s.rows[0].id))).rejects.toMatchObject({
      response: { error: { code: 'AIRTABLE_NOT_CONNECTED' } },
    });
    expect(s.rows[0].status).toBe('active');
  });
});

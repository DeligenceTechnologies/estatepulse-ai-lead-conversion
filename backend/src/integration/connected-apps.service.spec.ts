import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { appTools } from '@/assistant/tools/app.tools';
import { ConnectedAppsService } from './connected-apps.service';

const ORG = 'org-1';
const owner: AuthContext = { userId: 'u1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['integration.read', 'integration.update'] };
const agent: AuthContext = { userId: 'u2', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };
const VERIFIED = new Date('2026-11-25T10:00:00Z');
const SYNCED = new Date('2026-11-26T09:00:00Z');

const integration = (over: object) => ({
  id: 'int-1',
  provider: 'telnyx',
  status: 'active',
  label: null,
  accountEmail: null,
  accountName: null,
  phoneNumber: '+15125550100',
  lastVerifiedAt: VERIFIED,
  lastErrorAt: null,
  lastErrorCode: null,
  ...over,
});

function setup(opts: { integrations?: object[]; calendar?: object | null; runs?: object[] } = {}) {
  const prisma = {
    integration: { findMany: vi.fn(async () => opts.integrations ?? []) },
    calendarConnection: { findFirst: vi.fn(async () => (opts.calendar === undefined ? null : opts.calendar)) },
    crmSyncRun: { findMany: vi.fn(async () => opts.runs ?? []) },
  };
  return { prisma, service: new ConnectedAppsService(prisma as any) };
}

describe('connected apps', () => {
  it('a working phone connection is connected, fixed under Settings > Telnyx', async () => {
    const { apps } = await setup({ integrations: [integration({})] }).service.list(owner);
    expect(apps).toEqual([
      { id: 'int-1', provider: 'telnyx', label: 'Telnyx', account: '+15125550100', state: 'connected', lastSyncAt: VERIFIED.toISOString(), message: null, reconnectPath: '/settings?tab=telnyx' },
    ]);
  });

  it('a Telnyx key refused on a live call, or any app marked invalid, needs reconnecting, with what it stops', async () => {
    const { apps } = await setup({
      integrations: [integration({ lastErrorCode: 'TELNYX_KEY_REJECTED' }), integration({ id: 'int-2', provider: 'google', status: 'invalid', accountEmail: 'o@x.test' })],
    }).service.list(owner);
    expect(apps.map((a) => [a.label, a.state, a.message])).toEqual([
      ['Telnyx', 'needs_reconnect', 'Telnyx stopped accepting the connection. AI calls and text messages to leads are failing.'],
      ['Google', 'needs_reconnect', 'Google stopped accepting the connection. New leads from Google Sheets and Forms are not being imported.'],
    ]);
    expect(apps[1].reconnectPath).toBe('/integrations');
  });

  it("a CRM's newest sync run says whether it is syncing or failing", async () => {
    const hubspot = integration({ id: 'hs', provider: 'hubspot', phoneNumber: null, accountName: 'Acme' });
    const syncing = await setup({ integrations: [hubspot], runs: [{ status: 'running', errorMessage: null, finishedAt: null, leadSource: { integrationId: 'hs' } }] }).service.list(owner);
    expect(syncing.apps[0].state).toBe('syncing');
    const failed = await setup({
      integrations: [hubspot],
      runs: [
        { status: 'failed', errorMessage: 'HubSpot rate limit', finishedAt: SYNCED, leadSource: { integrationId: 'hs' } },
        { status: 'succeeded', errorMessage: null, finishedAt: VERIFIED, leadSource: { integrationId: 'hs' } },
      ],
    }).service.list(owner);
    expect(failed.apps[0]).toMatchObject({ state: 'error', message: 'The last sync failed: HubSpot rate limit.', lastSyncAt: SYNCED.toISOString() });
  });

  it('the calendar in use: broken needs reconnecting under Settings > Calendar; a failing sync is an error', async () => {
    const calendar = { id: 'cal-1', provider: 'calendly', status: 'error', accountEmail: 'o@x.test', accountName: null, lastError: 'invalid_grant', syncError: null, meetingsError: null, syncedAt: SYNCED, meetingsSyncedAt: null };
    const broken = await setup({ calendar }).service.list(owner);
    expect(broken.apps[0]).toMatchObject({ label: 'Calendly', state: 'needs_reconnect', reconnectPath: '/settings?tab=calendar', lastSyncAt: SYNCED.toISOString() });
    const failing = await setup({ calendar: { ...calendar, status: 'active', meetingsError: 'Calendly returned 500' } }).service.list(owner);
    expect(failing.apps[0]).toMatchObject({ state: 'error', message: 'Syncing with Calendly is failing: Calendly returned 500' });
  });

  it('everyone sees the states; only integration.read sees accounts and only integration.update may reconnect', async () => {
    const s = setup({ integrations: [integration({})] });
    expect(await s.service.list(owner)).toMatchObject({ canReconnect: true, apps: [{ account: '+15125550100' }] });
    expect(await s.service.list(agent)).toMatchObject({ canReconnect: false, apps: [{ account: null, state: 'connected' }] });
  });

  it('leaves out connections that were disconnected or switched off', async () => {
    const s = setup();
    await s.service.list(owner);
    expect((s.prisma.integration.findMany.mock.calls[0] as any[])[0].where).toEqual({ orgId: ORG, revokedAt: null, status: { in: ['active', 'invalid'] } });
    expect((s.prisma.calendarConnection.findFirst.mock.calls[0] as any[])[0].where).toEqual({ orgId: ORG, status: { in: ['active', 'error'] } });
  });
});

describe('integration_status tool', () => {
  it('names the screen where each app is fixed, and whether this user can do it', async () => {
    const s = setup({ integrations: [integration({ lastErrorCode: 'TELNYX_KEY_REJECTED' })] });
    const [tool] = appTools(s.service) as any[];
    expect(await tool.run({ auth: agent, refs: {} }, {})).toEqual({
      apps: [{ app: 'Telnyx', state: 'needs_reconnect', lastSync: VERIFIED.toISOString(), problem: expect.stringContaining('AI calls'), fixedOn: 'Settings > Telnyx' }],
      userCanReconnect: false,
    });
  });
});

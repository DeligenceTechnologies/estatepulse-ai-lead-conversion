import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AssistantActivityService } from './assistant-activity.service';
import { activityTools } from './tools/activity.tools';
import { fakeRefs } from './tools/fake-refs.test';

const ORG = 'org-1';
const NOW = new Date('2026-11-26T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read', 'integration.read', 'integration.update'] };
const agent: AuthContext = { userId: 'agent-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };

const maria = { id: 'lead-1', firstName: 'Maria', lastName: 'Lopez' };
const raj = { id: 'lead-2', firstName: 'Raj', lastName: 'Mehta' };

const event = (id: string, type: string, min: number, over: object = {}) => ({
  id,
  type,
  toStatus: null,
  reason: null,
  actorType: 'system',
  actorId: null,
  payload: null,
  createdAt: ago(min),
  lead: maria,
  ...over,
});

function setup(opts: { events?: object[]; booked?: object[]; canceled?: object[]; runs?: object[]; cards?: object[]; apps?: object[] } = {}) {
  const prisma = {
    leadEvent: { findMany: vi.fn(async () => opts.events ?? []) },
    calendarMeeting: { findMany: vi.fn(async (args: any) => (args.where.status === 'canceled' ? (opts.canceled ?? []) : (opts.booked ?? []))) },
    crmSyncRun: { findMany: vi.fn(async () => opts.runs ?? []) },
    assistantAction: { findMany: vi.fn(async () => opts.cards ?? []) },
    user: { findMany: vi.fn(async () => [{ id: 'owner-1', firstName: 'Sunny', lastName: 'Patel', email: 's@x.test' }]) },
  };
  const apps = { list: vi.fn(async (auth: AuthContext) => ({ apps: opts.apps ?? [], canReconnect: auth.permissions.includes('integration.update') })) };
  return { prisma, apps, service: new AssistantActivityService(prisma as any, apps as any) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('activity feed', () => {
  it('tells the office what matters, newest first, and leaves out the routine moves', async () => {
    const s = setup({
      events: [
        event('e1', 'status_changed', 5, { toStatus: 'appointment_requested' }),
        event('e2', 'status_changed', 10, { toStatus: 'contacting' }),
        event('e3', 'opted_out', 20, { lead: raj }),
        event('e4', 'outreach_paused', 30, { actorType: 'user', actorId: 'owner-1', reason: 'On holiday' }),
      ],
      booked: [{ id: 'm1', startsAt: new Date('2026-11-27T21:00:00Z'), createdAt: ago(1), bookedVia: 'ai_call', hostUser: { firstName: 'Priya', lastName: 'Shah' }, lead: raj }],
    });
    const feed = await s.service.feed(owner);
    expect(feed.items.map((i) => [i.kind, i.lead?.name, i.text])).toEqual([
      ['meeting_booked', 'Raj Mehta', 'booked a meeting with Priya Shah'],
      ['meeting_requested', 'Maria Lopez', 'wants a meeting'],
      ['opted_out', 'Raj Mehta', 'asked not to be contacted'],
      ['outreach_paused', 'Maria Lopez', 'outreach paused by Sunny Patel: On holiday'],
    ]);
    expect(feed.items[0].meetingAt).toBe('2026-11-27T21:00:00.000Z');
    expect(feed.nextCursor).toBeNull();
  });

  it('looks only at the last 24 hours, and only at leads the user may see', async () => {
    const s = setup();
    await s.service.feed(agent);
    const where = (s.prisma.leadEvent.findMany.mock.calls[0] as any[])[0].where;
    expect(where.createdAt).toEqual({ gte: ago(24 * 60), lt: NOW });
    expect(where.lead).toMatchObject({ orgId: ORG, mergedIntoId: null, assignedToId: 'agent-1' });
    expect((s.prisma.calendarMeeting.findMany.mock.calls[0] as any[])[0].where.lead).toMatchObject({ assignedToId: 'agent-1' });
  });

  it('shows CRM syncs with new or changed leads, and failures, only to people who may see integrations', async () => {
    const runs = [
      { id: 'r1', provider: 'HUBSPOT', status: 'succeeded', created: 3, updated: 1, errorMessage: null, finishedAt: ago(2) },
      { id: 'r2', provider: 'HUBSPOT', status: 'succeeded', created: 0, updated: 0, errorMessage: null, finishedAt: ago(3) },
      { id: 'r3', provider: 'BOLDTRAIL', status: 'failed', created: 0, updated: 0, errorMessage: 'Token expired', finishedAt: ago(4) },
    ];
    const forOwner = await setup({ runs }).service.feed(owner);
    expect(forOwner.items.map((i) => i.text)).toEqual(['HubSpot sync: 3 new, 1 updated', 'BoldTrail sync failed: Token expired']);
    const forAgent = setup({ runs });
    expect((await forAgent.service.feed(agent)).items).toEqual([]);
    expect(forAgent.prisma.crmSyncRun.findMany).not.toHaveBeenCalled();
  });

  it("puts this user's open approval cards and broken apps on top", async () => {
    const s = setup({
      cards: [{ id: 'a1', threadId: 't1', toolName: 'text_send', preview: { title: 'Text Maria Lopez' }, createdAt: ago(1), expiresAt: new Date(NOW.getTime() + 9 * 60_000) }],
      apps: [
        { label: 'Calendly', state: 'needs_reconnect', message: 'Calendly stopped accepting the connection. Leads cannot book meetings.', impact: 'Leads cannot book meetings.', reconnectPath: '/settings?tab=calendar' },
        { label: 'HubSpot', state: 'connected', message: null, impact: null, reconnectPath: '/integrations' },
      ],
    });
    const feed = await s.service.feed(owner);
    expect(feed.needsYou).toEqual([{ actionId: 'a1', threadId: 't1', title: 'Text Maria Lopez', createdAt: ago(1).toISOString(), expiresAt: expect.any(String) }]);
    expect(feed.alerts).toEqual([{ app: 'Calendly', state: 'needs_reconnect', message: 'Leads cannot book meetings.', reconnectPath: '/settings?tab=calendar' }]);
    expect(feed.canReconnect).toBe(true);
    expect((s.prisma.assistantAction.findMany.mock.calls[0] as any[])[0].where).toMatchObject({ orgId: ORG, userId: 'owner-1', status: 'proposed' });
  });

  it('pages: a full page gives a cursor, and the next page starts before it without the top section', async () => {
    const events = Array.from({ length: 35 }, (_, i) => event(`e${i}`, 'opted_out', i + 1));
    const s = setup({ events });
    const first = await s.service.feed(owner);
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toBe(ago(30).toISOString());
    const next = await s.service.feed(owner, { before: new Date(first.nextCursor!) });
    expect((s.prisma.leadEvent.findMany.mock.calls[1] as any[])[0].where.createdAt.lt).toEqual(ago(30));
    expect(next.alerts).toEqual([]);
    expect(s.apps.list).toHaveBeenCalledTimes(1);
  });
});

describe('activity_feed tool', () => {
  it('gives leads as refs, never ids', async () => {
    const s = setup({ events: [event('e1', 'status_changed', 5, { toStatus: 'interested' })] });
    const [tool] = activityTools(s.service) as any[];
    const out = await tool.run({ auth: owner, refs: fakeRefs() }, { hours: 24 });
    expect(out.events).toEqual([{ at: ago(5).toISOString(), lead: { ref: 'L1', name: 'Maria Lopez' }, what: 'is interested' }]);
    expect(JSON.stringify(out)).not.toContain('lead-1');
  });
});

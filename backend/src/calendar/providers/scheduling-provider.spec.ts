import { describe, expect, it, vi } from 'vitest';
import type { CalClient } from './cal.client';
import type { CalendlyClient } from './calendly.client';
import { SchedulingProvider, type WorkspaceRef } from './scheduling-provider';

const member = { externalId: 'm1', name: 'Ada', email: 'ada@x.io', role: 'owner', schedulingUrl: null, timezone: null, username: 'ada' };

function setup() {
  const calendly = {
    members: vi.fn().mockResolvedValue([member]),
    eventTypes: vi.fn().mockResolvedValue([]),
    scheduledMeetings: vi.fn().mockResolvedValue([]),
    defaultSchedule: vi.fn().mockResolvedValue(null),
    currentUser: vi.fn().mockResolvedValue({}),
    deleteWebhook: vi.fn().mockResolvedValue(undefined),
  };
  const cal = {
    members: vi.fn().mockResolvedValue([member]),
    personalMember: vi.fn().mockResolvedValue(member),
    teamEventTypes: vi.fn().mockResolvedValue([]),
    personalEventTypes: vi.fn().mockResolvedValue([]),
    scheduledMeetings: vi.fn().mockResolvedValue([]),
    defaultSchedule: vi.fn().mockResolvedValue(null),
    me: vi.fn().mockResolvedValue({}),
    deleteWebhook: vi.fn().mockResolvedValue(undefined),
  };
  return { calendly, cal, provider: new SchedulingProvider(calendly as unknown as CalendlyClient, cal as unknown as CalClient) };
}

const calendlyOrg: WorkspaceRef = { provider: 'calendly', workspaceType: 'organization', workspaceId: 'org-uri', workspaceSlug: null };
const calTeam: WorkspaceRef = { provider: 'cal', workspaceType: 'team', workspaceId: '42', workspaceSlug: 'sales' };
const calPersonal: WorkspaceRef = { provider: 'cal', workspaceType: 'personal', workspaceId: '7', workspaceSlug: 'ada' };

describe('SchedulingProvider', () => {
  it('reads members from the right workspace', async () => {
    const { calendly, cal, provider } = setup();
    await provider.members(calendlyOrg, 'token');
    expect(calendly.members).toHaveBeenCalledWith('token', 'org-uri');
    await provider.members(calTeam, 'key');
    expect(cal.members).toHaveBeenCalledWith('key', '42');
    await expect(provider.members(calPersonal, 'key')).resolves.toEqual([member]);
    expect(cal.personalMember).toHaveBeenCalledWith('key');
  });

  it('reads meeting types from the right workspace', async () => {
    const { calendly, cal, provider } = setup();
    await provider.eventTypes(calendlyOrg, 'token');
    expect(calendly.eventTypes).toHaveBeenCalledWith('token', 'org-uri');
    await provider.eventTypes(calTeam, 'key');
    expect(cal.teamEventTypes).toHaveBeenCalledWith('key', '42', 'sales');
    await provider.eventTypes(calPersonal, 'key');
    expect(cal.personalEventTypes).toHaveBeenCalledWith('key', 'ada');
  });

  it('reads booked meetings from the right workspace', async () => {
    const { calendly, cal, provider } = setup();
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    await provider.meetings(calendlyOrg, 'token', from, to);
    expect(calendly.scheduledMeetings).toHaveBeenCalledWith('token', 'org-uri', from, to);
    await provider.meetings(calTeam, 'key', from, to);
    expect(cal.scheduledMeetings).toHaveBeenLastCalledWith('key', from, to, '42');
    await provider.meetings(calPersonal, 'key', from, to);
    expect(cal.scheduledMeetings).toHaveBeenLastCalledWith('key', from, to, null);
  });

  it("reads any Calendly member's schedule, but only the key owner's on Cal.com", async () => {
    const { calendly, cal, provider } = setup();
    await provider.memberSchedule({ ...calendlyOrg, accountId: 'me' }, 'token', 'user-uri');
    expect(calendly.defaultSchedule).toHaveBeenCalledWith('token', 'user-uri');
    await expect(provider.memberSchedule({ ...calTeam, accountId: '7' }, 'key', '8')).resolves.toBeNull();
    expect(cal.defaultSchedule).not.toHaveBeenCalled();
    await provider.memberSchedule({ ...calTeam, accountId: '7' }, 'key', '7');
    expect(cal.defaultSchedule).toHaveBeenCalledWith('key');
  });

  it('verifies and removes webhooks on the matching provider only', async () => {
    const { calendly, cal, provider } = setup();
    await provider.verify('cal', 'key');
    await provider.deleteWebhook('calendly', 'token', 'hook');
    expect(cal.me).toHaveBeenCalledWith('key');
    expect(calendly.currentUser).not.toHaveBeenCalled();
    expect(calendly.deleteWebhook).toHaveBeenCalledWith('token', 'hook');
    expect(cal.deleteWebhook).not.toHaveBeenCalled();
  });
});

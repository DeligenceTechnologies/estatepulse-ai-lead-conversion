import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { CalendarMeeting } from '@prisma/client';
import type { PrismaService } from '@/common/prisma/prisma.service';
import type { SecretBoxService } from '@/common/service/secret-box.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import type { BookedMeeting } from '../calendar.types';
import type { CalendarAccessService, UsableConnection } from '../connection/calendar-access.service';
import type { CalClient } from '../providers/cal.client';
import type { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import type { SchedulingProvider } from '../providers/scheduling-provider';
import { CalendarSyncService, meetingRow, withHostZones } from '../sync/calendar-sync.service';
import { toBookedMeeting } from './meeting-types.service';

const booked: BookedMeeting = {
  id: 'https://api.calendly.com/scheduled_events/abc',
  eventTypeId: 'https://api.calendly.com/event_types/demo',
  title: 'Property tour',
  // An offset in the provider's answer; the row keeps the same instant.
  start: '2026-10-20T15:00:00+05:30',
  end: '2026-10-20T15:30:00+05:30',
  timezone: 'America/Toronto',
  status: 'scheduled',
  invitees: [{ name: 'Priya Shah', email: 'priya@example.com', timezone: 'Asia/Kolkata' }],
  hosts: [{ name: 'Rohit', email: 'rohit@example.com', timezone: 'America/Toronto' }],
  meetingUrl: 'https://meet.google.com/xyz',
  location: null,
  rescheduleUrl: 'https://calendly.com/reschedule/1',
  cancelUrl: 'https://calendly.com/cancel/1',
  canceledReason: null,
};

const asRow = (meeting: BookedMeeting): CalendarMeeting => ({
  id: 'row-1',
  orgId: 'o1',
  connectionId: 'c1',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...meetingRow(meeting, new Date()),
});

describe('meeting rows', () => {
  it("fills the host's timezone from their calendar member", () => {
    const calendly = { ...booked, timezone: null, hosts: [{ name: 'Rohit', email: 'Rohit@Example.com', timezone: null }] };
    const zones = new Map([['rohit@example.com', 'America/Toronto']]);
    expect(withHostZones(calendly, zones)).toMatchObject({
      timezone: 'America/Toronto',
      hosts: [{ timezone: 'America/Toronto' }],
    });
  });

  it('keeps only real timezones', () => {
    const row = asRow({ ...booked, timezone: 'Nowhere/Land', invitees: [{ name: 'A', email: null, timezone: 'x' }] });
    expect(row.timezone).toBeNull();
    expect(row.invitees).toEqual([{ name: 'A', email: null, timezone: null }]);
  });

  it('stores the instant (UTC) and reads back the same meeting', () => {
    const row = asRow(booked);
    expect(row.startsAt.toISOString()).toBe('2026-10-20T09:30:00.000Z');
    expect(toBookedMeeting(row, Date.parse('2026-10-14T00:00:00Z'))).toEqual({
      ...booked,
      start: '2026-10-20T09:30:00.000Z',
      end: '2026-10-20T10:00:00.000Z',
    });
  });

  it('drops reschedule and cancel links once the meeting is over or canceled', () => {
    const after = Date.parse('2026-10-21T00:00:00Z');
    expect(toBookedMeeting(asRow(booked), after)).toMatchObject({ rescheduleUrl: null, cancelUrl: null });
    const canceled = toBookedMeeting(asRow({ ...booked, status: 'canceled', canceledReason: 'Busy' }), 0);
    expect(canceled).toMatchObject({ cancelUrl: null, canceledReason: 'Busy' });
  });
});

function setup(meetings: SchedulingProvider['meetings'], meetingsSyncedAt: Date | null = null) {
  const upsert = vi.fn((args: unknown) => args);
  const prisma = {
    calendarConnection: {
      findUnique: vi.fn().mockResolvedValue({ meetingsSyncedAt }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    calendarMember: { findMany: vi.fn().mockResolvedValue([]) },
    calendarMeeting: { upsert },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  const provider = { meetings: vi.fn(meetings) };
  const service = new CalendarSyncService(
    prisma as unknown as PrismaService,
    {} as SecretBoxService,
    {} as CalendarAccessService,
    provider as unknown as SchedulingProvider,
    {} as CalendlyClient,
    {} as CalClient,
    { get: () => undefined } as unknown as ConfigService<IntegrationEnv, true>,
  );
  const connection = { id: 'c1', orgId: 'o1', provider: 'calendly' } as UsableConnection;
  const pull = (refresh: 'due' | 'now') =>
    (service as unknown as { pullMeetings: (...args: unknown[]) => Promise<void> }).pullMeetings(connection, 'token', refresh);
  return { prisma, provider, upsert, pull };
}

describe('CalendarSyncService meetings', () => {
  it('saves each meeting once and marks the time', async () => {
    const { prisma, upsert, pull } = setup(async () => [booked, booked, { ...booked, id: 'bad', start: 'nope' }]);
    await pull('now');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { meetingsSyncedAt: expect.any(Date), meetingsError: null },
    });
  });

  it('skips a routine sync while the saved meetings are fresh, but not a forced one', async () => {
    const { provider, pull } = setup(async () => [], new Date());
    await pull('due');
    expect(provider.meetings).not.toHaveBeenCalled();
    await pull('now');
    expect(provider.meetings).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved meetings and records the error when the provider fails', async () => {
    const { prisma, upsert, pull } = setup(async () => {
      throw new ProviderHttpError('Calendly', 503, 'down');
    });
    await pull('now');
    expect(upsert).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { meetingsError: 'down' } });
  });

  it('still fails the sync when the token is rejected', async () => {
    const { pull } = setup(async () => {
      throw new ProviderHttpError('Calendly', 401, 'revoked');
    });
    await expect(pull('now')).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

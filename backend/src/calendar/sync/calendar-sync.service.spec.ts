import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@/common/prisma/prisma.service';
import type { SecretBoxService } from '@/common/service/secret-box.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import type { CalendarAccessService } from '../connection/calendar-access.service';
import type { CalClient } from '../providers/cal.client';
import type { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import type { SchedulingProvider } from '../providers/scheduling-provider';
import { CalendarSyncService } from './calendar-sync.service';

const member = { id: 'm1', externalId: 'user-uri', name: 'Ada', username: null };
const window = { from: Date.UTC(2026, 9, 14), until: Date.UTC(2026, 9, 28) };
const hours = { timezone: 'Asia/Kolkata', weekly: { '1': [{ from: '10:00', to: '18:00' }] }, dates: {} };

function setup(defaultSchedule: CalendlyClient['defaultSchedule'], stored: object | null = null) {
  const calendly = { defaultSchedule: vi.fn(defaultSchedule), busyTimes: vi.fn().mockResolvedValue([]) };
  const prisma = { calendarMember: { findUnique: vi.fn().mockResolvedValue({ schedule: stored }) } };
  const service = new CalendarSyncService(
    prisma as unknown as PrismaService,
    {} as SecretBoxService,
    {} as CalendarAccessService,
    {} as SchedulingProvider,
    calendly as unknown as CalendlyClient,
    {} as CalClient,
    { get: () => undefined } as unknown as ConfigService<IntegrationEnv, true>,
  );
  const pull = () =>
    (service as unknown as { pullCalendly: (...args: unknown[]) => Promise<Record<string, unknown>> }).pullCalendly(
      'token',
      member,
      window,
    );
  return { calendly, pull };
}

describe('CalendarSyncService Calendly working hours', () => {
  it('reads the schedule on every sync, so a change shows on the next one', async () => {
    const { calendly, pull } = setup(async () => hours);
    await pull();
    const result = await pull();
    expect(calendly.defaultSchedule).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      schedule: { hours: { weekly: hours.weekly, dates: {} }, timezone: 'Asia/Kolkata' },
      status: 'ok',
      message: null,
    });
  });

  it('saves "no hours" when Calendly has none', async () => {
    const { pull } = setup(async () => null);
    expect(await pull()).toMatchObject({ schedule: { hours: null, timezone: null }, status: 'limited' });
  });

  it('keeps the last hours when the schedule cannot be read', async () => {
    const { pull } = setup(async () => {
      throw new ProviderHttpError('Calendly', 503, 'down');
    }, hours);
    const result = await pull();
    expect(result).not.toHaveProperty('schedule');
    expect(result).toMatchObject({ status: 'ok' });
  });

  it('still fails the sync when the token is rejected', async () => {
    const { pull } = setup(async () => {
      throw new ProviderHttpError('Calendly', 401, 'revoked');
    });
    await expect(pull()).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

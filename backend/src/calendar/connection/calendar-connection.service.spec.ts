import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '@/common/prisma/prisma.service';
import type { SecretBoxService } from '@/common/service/secret-box.service';
import type { CalClient } from '../providers/cal.client';
import type { CalendlyClient } from '../providers/calendly.client';
import type { CalendarAccessService, UsableConnection } from './calendar-access.service';
import { CalendarConnectionService } from './calendar-connection.service';

const connection = (overrides: Partial<UsableConnection> = {}): UsableConnection => ({
  id: 'cal-1',
  orgId: 'o1',
  provider: 'cal',
  status: 'inactive',
  workspaceType: 'team',
  workspaceId: '42',
  workspaceSlug: 'sales',
  accountId: '7',
  credentials: 'sealed-cal',
  tokenExpiresAt: null,
  lastError: null,
  webhookId: null,
  ...overrides,
});

const calendlyInUse = connection({ id: 'calendly-1', provider: 'calendly', status: 'active', webhookId: 'hook-1' });

function setup(saved: UsableConnection | null, { inUse = [calendlyInUse], switchedOn = 1 } = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    calendarConnection: {
      findMany: vi.fn().mockResolvedValue(inUse),
      // First call switches the one in use off, the second switches the saved one on.
      updateMany: vi.fn().mockResolvedValueOnce({ count: inUse.length }).mockResolvedValue({ count: switchedOn }),
    },
  };
  const prisma = {
    calendarConnection: {
      findUnique: vi.fn().mockResolvedValue(saved),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const access = { verify: vi.fn().mockResolvedValue(undefined), removeWebhook: vi.fn().mockResolvedValue(undefined) };
  const service = new CalendarConnectionService(
    prisma as unknown as PrismaService,
    { enabled: true } as unknown as SecretBoxService,
    access as unknown as CalendarAccessService,
    { configured: true, missingConfig: [] } as unknown as CalendlyClient,
    {} as unknown as CalClient,
  );
  return { service, prisma, tx, access };
}

describe('CalendarConnectionService.activate', () => {
  it('switches the saved connection on and the one in use off, then drops the old webhook', async () => {
    const { service, tx, access } = setup(connection());
    await service.activate('o1', 'cal');

    expect(access.verify).toHaveBeenCalledWith('o1', expect.objectContaining({ id: 'cal-1' }));
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.calendarConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'o1', status: { in: ['active', 'error'] }, id: { not: 'cal-1' } } }),
    );
    expect(tx.calendarConnection.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['calendly-1'] } },
      data: expect.objectContaining({ status: 'inactive', webhookId: null, webhookSecret: null }),
    });
    expect(tx.calendarConnection.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'cal-1', status: 'inactive', credentials: 'sealed-cal', lastError: null },
      data: expect.objectContaining({ status: 'active', syncedAt: null }),
    });
    expect(access.removeWebhook).toHaveBeenCalledWith(calendlyInUse);
  });

  it('does nothing when the provider is already in use', async () => {
    const { service, prisma, access } = setup(connection({ status: 'active' }));
    await service.activate('o1', 'cal');
    expect(access.verify).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('asks for a reconnect instead of switching to a broken connection', async () => {
    for (const broken of [connection({ status: 'error', lastError: 'Reconnect Cal.com.' }), connection({ lastError: 'Reconnect Cal.com.' })]) {
      const { service, access } = setup(broken);
      await expect(service.activate('o1', 'cal')).rejects.toThrow('Reconnect Cal.com.');
      expect(access.verify).not.toHaveBeenCalled();
    }
  });

  it('gives up without switching anything off when the saved connection changed meanwhile', async () => {
    const { service, access } = setup(connection(), { switchedOn: 0 });
    await expect(service.activate('o1', 'cal')).rejects.toBeInstanceOf(ConflictException);
    // The transaction rolled back, so the old connection's webhook is left alone.
    expect(access.removeWebhook).not.toHaveBeenCalled();
  });
});

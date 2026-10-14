import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '@/common/prisma/prisma.service';
import type { SecretBoxService } from '@/common/service/secret-box.service';
import type { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import type { SchedulingProvider } from '../providers/scheduling-provider';
import { CalendarAccessService, type UsableConnection } from './calendar-access.service';

// "Sealing" is JSON with a marker, enough to tell sealed from plain.
const seal = (value: unknown) => `sealed:${JSON.stringify(value)}`;

const connection = (overrides: Partial<UsableConnection> = {}): UsableConnection => ({
  id: 'c1',
  orgId: 'o1',
  provider: 'cal',
  status: 'active',
  workspaceType: 'team',
  workspaceId: '42',
  workspaceSlug: 'sales',
  accountId: '7',
  credentials: seal({ apiKey: 'key-1' }),
  tokenExpiresAt: null,
  lastError: null,
  webhookId: null,
  ...overrides,
});

function setup(found: (UsableConnection | null)[], parkedCount = 1) {
  const findFirst = vi.fn();
  for (const value of found) findFirst.mockResolvedValueOnce(value);
  const updateMany = vi.fn().mockResolvedValue({ count: parkedCount });
  const prisma = { calendarConnection: { findFirst, updateMany } } as unknown as PrismaService;
  const secrets = {
    enabled: true,
    seal: (plain: string) => `sealed:${plain}`,
    open: (sealed: string) => sealed.replace(/^sealed:/, ''),
  } as unknown as SecretBoxService;
  const calendly = { configured: true, refresh: vi.fn(), revoke: vi.fn() };
  const provider = { verify: vi.fn(), deleteWebhook: vi.fn() };
  const service = new CalendarAccessService(
    prisma,
    secrets,
    calendly as unknown as CalendlyClient,
    provider as unknown as SchedulingProvider,
  );
  return { service, findFirst, updateMany, calendly, provider };
}

describe('CalendarAccessService.useActive', () => {
  it('runs with the decrypted secret of the active connection', async () => {
    const { service } = setup([connection()]);
    const run = vi.fn().mockResolvedValue('ok');
    await expect(service.useActive('o1', run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'key-1');
  });

  it('says so when nothing is connected', async () => {
    const { service } = setup([null]);
    await expect(service.useActive('o1', vi.fn())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a connection already marked broken, without calling the provider', async () => {
    const { service } = setup([connection({ status: 'error', lastError: 'Reconnect Cal.com.' })]);
    const run = vi.fn();
    await expect(service.useActive('o1', run)).rejects.toThrow('Reconnect Cal.com.');
    expect(run).not.toHaveBeenCalled();
  });

  it('marks the connection broken when the provider rejects the credentials', async () => {
    const { service, updateMany } = setup([connection()]);
    const run = vi.fn().mockRejectedValue(new ProviderHttpError('Cal.com', 401, 'Unauthorized'));
    await expect(service.useActive('o1', run)).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', orgId: 'o1', credentials: seal({ apiKey: 'key-1' }), status: 'active' },
      data: { status: 'error', lastError: expect.stringContaining('Reconnect Cal.com') },
    });
  });

  it('only records the error on a saved connection that fails its check, keeping it switched off', async () => {
    const { service, updateMany, provider } = setup([]);
    provider.verify.mockRejectedValue(new ProviderHttpError('Cal.com', 401, 'Unauthorized'));
    await expect(service.verify('o1', connection({ status: 'inactive' }))).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', orgId: 'o1', credentials: seal({ apiKey: 'key-1' }), status: 'inactive' },
      data: { lastError: expect.stringContaining('Reconnect Cal.com') },
    });
  });

  it('retries once with the new connection when someone reconnected mid-call', async () => {
    const fresh = connection({ credentials: seal({ apiKey: 'key-2' }) });
    const { service } = setup([connection(), fresh], 0);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ProviderHttpError('Cal.com', 401, 'Unauthorized'))
      .mockResolvedValueOnce('ok');
    await expect(service.useActive('o1', run)).resolves.toBe('ok');
    expect(run).toHaveBeenLastCalledWith(fresh, 'key-2');
  });

  it('reports other provider failures as a bad gateway, leaving the connection alone', async () => {
    const { service, updateMany } = setup([connection()]);
    const run = vi.fn().mockRejectedValue(new ProviderHttpError('Cal.com', 503, 'Down'));
    await expect(service.useActive('o1', run)).rejects.toBeInstanceOf(BadGatewayException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('asks for a reconnect when the stored credentials cannot be decrypted', async () => {
    const { service } = setup([connection({ credentials: 'garbage' })]);
    await expect(service.useActive('o1', vi.fn())).rejects.toThrow('cannot be read');
  });
});

describe('CalendarAccessService Calendly tokens', () => {
  const calendly = (expiresInMs: number) =>
    connection({
      provider: 'calendly',
      credentials: seal({ accessToken: 'old', refreshToken: 'r1' }),
      tokenExpiresAt: new Date(Date.now() + expiresInMs),
    });

  it('uses the stored token while it is still valid', async () => {
    const { service, calendly: client } = setup([calendly(60 * 60_000)]);
    const run = vi.fn().mockResolvedValue('ok');
    await service.useActive('o1', run);
    expect(run).toHaveBeenCalledWith(expect.anything(), 'old');
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('refreshes a token close to expiry once, even for concurrent calls', async () => {
    const stale = calendly(60_000);
    const { service, calendly: client, updateMany } = setup([stale, stale]);
    client.refresh.mockResolvedValue({ accessToken: 'new', refreshToken: 'r2', expiresAt: new Date(Date.now() + 3_600_000) });
    const run = vi.fn().mockResolvedValue('ok');
    await Promise.all([service.useActive('o1', run), service.useActive('o1', run)]);
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), 'new');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1', credentials: stale.credentials } }),
    );
  });

  it('treats a dead refresh token as rejected credentials', async () => {
    const { service, calendly: client, updateMany } = setup([calendly(0)]);
    client.refresh.mockRejectedValue(new ProviderHttpError('Calendly', 400, 'invalid_grant'));
    await expect(service.useActive('o1', vi.fn())).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'error' }) }));
  });
});

describe('CalendarAccessService cleanup', () => {
  it('never lets a failed webhook removal break a disconnect', async () => {
    const { service, provider } = setup([]);
    provider.deleteWebhook.mockRejectedValue(new Error('gone'));
    await expect(service.removeWebhook(connection({ webhookId: 'hook' }))).resolves.toBeUndefined();
    expect(provider.deleteWebhook).toHaveBeenCalledWith('cal', 'key-1', 'hook');
  });

  it('revokes the refresh token stored in a Calendly connection', async () => {
    const { service, calendly } = setup([]);
    await service.revokeStoredCalendly(seal({ accessToken: 'a', refreshToken: 'r1' }));
    expect(calendly.revoke).toHaveBeenCalledWith('r1');
  });
});

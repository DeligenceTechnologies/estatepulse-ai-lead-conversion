import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../providers/provider.registry';
import { IntegrationsService } from './integrations.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = '11111111-1111-4111-8111-111111111111';
const KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });

const row = (id: string, provider: string) => ({
  id,
  organization_id: ORG,
  provider,
  label: null,
  credential_enc: 'v1.k1.x.y.z',
  credential_prefix: 'p',
  credential_last4: '1234',
  account_email: null,
  account_name: null,
  status: 'ACTIVE',
  last_verified_at: null,
  last_error_code: null,
  created_at: new Date(),
});

function setup(rows: any[]) {
  const prisma: any = {
    provider_credentials: {
      findMany: vi.fn().mockResolvedValue(rows),
      findFirst: vi.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      update: vi.fn(),
    },
    lead_sources: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
  };
  const registry = new ProviderRegistry([{ provider: 'TALLY', displayName: 'Tally' } as any]);
  const config = new ConfigService({ ENCRYPTION_KEYS: KEYS, ENCRYPTION_ACTIVE_KEY_ID: 'k1' });
  return { svc: new IntegrationsService(prisma, config, registry), prisma };
}

describe('IntegrationsService and non-form credentials', () => {
  const rows = [row('tally-1', 'TALLY'), row('google-1', 'GOOGLE')];

  it('lists only credentials a form-provider adapter owns', async () => {
    const { svc } = setup(rows);
    expect((await svc.list(ORG)).map((c) => c.id)).toEqual(['tally-1']);
  });

  it('will not verify, revoke or hand out the Google grant', async () => {
    const { svc, prisma } = setup(rows);
    await expect(svc.verify(ORG, 'google-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.revoke(ORG, 'google-1', true)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.credentialFor(ORG, 'google-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.provider_credentials.update).not.toHaveBeenCalled();
  });
});

import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TelnyxCredentialsService } from './telnyx-credentials.service';

/** One calling provider per organization: Telnyx cannot be activated while Retell is the provider. */

const ORG = 'org-1';
const unique = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

function setup(retellActive: number, failure: Error = unique()) {
  const prisma = {
    integration: {
      findFirst: vi.fn().mockResolvedValue({ id: 'telnyx-row', orgId: ORG }),
      count: vi.fn().mockResolvedValue(retellActive),
    },
    $transaction: vi.fn().mockRejectedValue(failure),
  };
  return { svc: new TelnyxCredentialsService(prisma as any, {} as any), prisma };
}

describe('TelnyxCredentialsService and the one-calling-provider index', () => {
  it('says plainly that Retell is active, for every write that activates a Telnyx account', async () => {
    const { svc, prisma } = setup(1);
    await expect(svc.activateAccount(ORG, 'telnyx-row')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Retell is this organization’s calling provider') });
    await expect(svc.createAccount(ORG, {})).rejects.toMatchObject({ status: 409 });
    expect(prisma.integration.count).toHaveBeenCalledWith({ where: { orgId: ORG, provider: 'retell', status: 'active' } });
  });

  it('rethrows any other failure unchanged', async () => {
    const plain = setup(0);
    await expect(plain.svc.activateAccount(ORG, 'telnyx-row')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const other = setup(1, new Error('connection reset'));
    await expect(other.svc.activateAccount(ORG, 'telnyx-row')).rejects.toThrow('connection reset');
    expect(other.prisma.integration.count).not.toHaveBeenCalled();
  });
});

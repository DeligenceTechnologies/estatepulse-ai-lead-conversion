import type { Prisma } from '@prisma/client';

/** Serializes connection changes per organization, so two connects cannot both end up active. */
export async function lockOrganization(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
}

import type { PrismaService } from '@/common/prisma/prisma.service';

export interface LinkedUser {
  id: string;
  name: string;
}

/**
 * The organization's users that calendar members are, matched by email
 * (case-insensitive). Keyed by lower-cased email.
 */
export async function findLinkedUsers(
  prisma: PrismaService,
  orgId: string,
  members: readonly { email: string }[],
): Promise<Map<string, LinkedUser>> {
  const emails = members.map((member) => member.email).filter(Boolean);
  if (emails.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { orgId, email: { in: emails, mode: 'insensitive' } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  return new Map(
    users.map((user) => [user.email.toLowerCase(), { id: user.id, name: `${user.firstName} ${user.lastName}`.trim() }]),
  );
}

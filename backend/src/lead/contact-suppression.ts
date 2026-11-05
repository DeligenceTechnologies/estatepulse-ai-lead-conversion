import type { Prisma } from '@prisma/client';
import type { PrismaService } from '@/common/prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

const CHUNK = 1000;

/** Of these phones, the ones the organization may not contact: whoever has the number opted out. */
export async function suppressedPhones(db: Db, orgId: string, phones: (string | null | undefined)[]): Promise<Set<string>> {
  const wanted = [...new Set(phones.filter((p): p is string => !!p))];
  const found = new Set<string>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const rows = await db.contactSuppression.findMany({
      where: { orgId, normalizedPhone: { in: wanted.slice(i, i + CHUNK) } },
      select: { normalizedPhone: true },
    });
    for (const r of rows) found.add(r.normalizedPhone);
  }
  return found;
}

export async function isSuppressed(db: Db, orgId: string, phone: string | null | undefined): Promise<boolean> {
  return (await suppressedPhones(db, orgId, [phone])).size > 0;
}

/** Why a new lead starts do-not-contact; shown with its review flag. */
export const DNC_REVIEW_REASON = 'This phone or email asked not to be contacted before: the lead starts as do-not-contact';

/** Whether a new lead must start do-not-contact: its phone opted out, or an opted-out lead has its email. */
export async function startsDoNotContact(db: Db, orgId: string, phone: string | null, email: string | null): Promise<boolean> {
  if (phone && (await isSuppressed(db, orgId, phone))) return true;
  return Boolean(email) && (await db.lead.count({ where: { orgId, dncStatus: true, normalizedEmail: email } })) > 0;
}

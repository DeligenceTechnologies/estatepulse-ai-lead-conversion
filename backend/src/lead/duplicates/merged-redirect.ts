import type { Prisma } from '@prisma/client';
import type { PrismaService } from '@/common/prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/** A merge of a merge of a merge… is followed this far, and no further (a loop would be a bug, not a person). */
const MAX_HOPS = 5;

/** Where a merged lead's person lives now: its mergedIntoId, followed to a lead that is not merged. */
export async function survivorOf(db: Db, leadId: string): Promise<string | null> {
  let id: string | null = leadId;
  for (let hop = 0; id && hop <= MAX_HOPS; hop += 1) {
    const row: { mergedIntoId: string | null } | null = await db.lead.findUnique({ where: { id }, select: { mergedIntoId: true } });
    if (!row) return null;
    if (!row.mergedIntoId) return id;
    id = row.mergedIntoId;
  }
  return null;
}

/**
 * The lead a phone number belongs to. A merge keeps a second number the person used on the merged
 * lead (the survivor has its own), so a text or call from it reaches the survivor instead of
 * becoming a stranger. Live leads win; the newest first, as before.
 */
export async function leadByPhone<S extends Prisma.LeadSelect>(
  db: Db,
  orgId: string,
  phone: string | null,
  select: S,
): Promise<Prisma.LeadGetPayload<{ select: S }> | null> {
  if (!phone) return null;
  const live = await db.lead.findFirst({ where: { orgId, normalizedPhone: phone, mergedIntoId: null }, orderBy: { createdAt: 'desc' }, select });
  if (live) return live as Prisma.LeadGetPayload<{ select: S }>;
  const merged = await db.lead.findFirst({
    where: { orgId, normalizedPhone: phone, mergedIntoId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const survivor = merged ? await survivorOf(db, merged.id) : null;
  if (!survivor) return null;
  return (await db.lead.findUnique({ where: { id: survivor }, select })) as Prisma.LeadGetPayload<{ select: S }> | null;
}

/**
 * Leads matched on a phone or email, with every merged one replaced by its survivor (still under the
 * key it matched on), so a submission from a merged lead's other number or address attaches to the
 * person rather than making them a new lead.
 */
export async function withSurvivors<T extends { id: string; mergedIntoId: string | null }>(db: Db, leads: T[]): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const l of leads) {
    const id = l.mergedIntoId ? await survivorOf(db, l.id) : l.id;
    if (!id) continue;
    const key = `${id}|${JSON.stringify({ ...l, id: undefined, mergedIntoId: undefined })}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...l, id, mergedIntoId: null });
  }
  return out;
}

import { LeadStatus, LeadTemperature, type Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import type { GuardedPrisma } from '@/common/prisma/prisma.service';
import { visible } from './lead-access';
import { leadRef, userRef, type RefTable } from './refs';
import type { ActionPreview, PreviewChange } from './tool';

/** One action holds at most this many leads. */
export const MAX_BULK = 500;
/** Leads named one by one, from refs the chat already has. */
export const MAX_BULK_REFS = 50;
/** Above this many leads, the user needs assistant.bulk and has to type the count to approve. */
export const TYPED_CONFIRM_ABOVE = 10;
const SAMPLE = 5;

/** Which leads a bulk tool acts on: refs from the chat, or a filter. The model never lists ids. */
export const bulkSelection = {
  leads: z.array(leadRef).min(1).max(MAX_BULK_REFS).optional().describe(`Up to ${MAX_BULK_REFS} lead refs from this chat. Use either leads or filter`),
  filter: z
    .object({
      status: z.array(z.enum(LeadStatus)).max(Object.keys(LeadStatus).length).optional(),
      temperature: z.enum(LeadTemperature).optional(),
      location: z.string().trim().max(100).optional().describe('Part of the area or city'),
      unassigned: z.boolean().optional().describe('True for leads with no agent'),
      assignedTo: userRef.optional(),
      createdAfter: z.iso.datetime({ offset: true }).optional(),
      createdBefore: z.iso.datetime({ offset: true }).optional(),
      noContactSince: z.iso.datetime({ offset: true }).optional().describe('Leads not contacted since this time (or never)'),
    })
    .strict()
    .optional()
    .describe('Which leads, by what they have in common. Use either leads or filter'),
};

export interface BulkSelectionInput {
  leads?: string[];
  filter?: {
    status?: LeadStatus[];
    temperature?: LeadTemperature;
    location?: string;
    unassigned?: boolean;
    assignedTo?: string;
    createdAfter?: string;
    createdBefore?: string;
    noContactSince?: string;
  };
}

/** The leads a bulk card is about, each one the user may see and out of import review. */
export async function selectLeads<S extends Prisma.LeadSelect>(prisma: GuardedPrisma, auth: AuthContext, refs: RefTable, input: BulkSelectionInput, select: S) {
  if (!!input.leads === !!input.filter) throw new AppError('VALIDATION_ERROR', 'Give either lead refs or a filter, not both and not neither.');
  let where: Prisma.LeadWhereInput;
  if (input.leads) {
    const ids = await Promise.all([...new Set(input.leads)].map((ref) => refs.resolve('lead', ref)));
    where = visible(auth, { id: { in: ids } });
  } else {
    const f = input.filter!;
    const assignedToId = f.assignedTo && !f.unassigned ? await refs.resolve('user', f.assignedTo) : undefined;
    where = visible(auth, {
      ...(f.status?.length ? { status: { in: f.status } } : {}),
      ...(f.temperature ? { temperature: f.temperature } : {}),
      ...(f.location ? { location: { contains: f.location, mode: 'insensitive' } } : {}),
      ...(f.unassigned ? { assignedToId: null } : assignedToId ? { assignedToId } : {}),
      ...(f.createdAfter || f.createdBefore
        ? { createdAt: { ...(f.createdAfter ? { gte: new Date(f.createdAfter) } : {}), ...(f.createdBefore ? { lt: new Date(f.createdBefore) } : {}) } }
        : {}),
      ...(f.noContactSince ? { OR: [{ lastContactAt: null }, { lastContactAt: { lt: new Date(f.noContactSince) } }] } : {}),
    });
  }
  const total = await prisma.lead.count({ where });
  if (total === 0) throw new AppError('NOT_FOUND', 'No leads match that.');
  if (total > MAX_BULK) {
    throw new AppError('BULK_LIMIT', `${total} leads match, and one action can take ${MAX_BULK}. Narrow the filter, for example by area, agent or date.`, undefined, 422);
  }
  const rows = await prisma.lead.findMany({ where, select: { ...select, id: true, firstName: true, lastName: true }, orderBy: { createdAt: 'desc' } });
  return rows as unknown as (Prisma.LeadGetPayload<{ select: S }> & { id: string; firstName: string | null; lastName: string | null })[];
}

export const nameOf = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || 'Unnamed lead';

/** "6 already with Priya Shah, 2 opted out". */
export function skippedLine(skipped: Record<string, number>): string {
  return Object.entries(skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${n} ${why}`)
    .join(', ');
}

/**
 * The card for a bulk action: how many leads, a few names, what was left out and why. Refuses
 * when every lead was left out, saying why, rather than showing an empty card.
 */
export function bulkCard(opts: {
  title: (count: number) => string;
  /** Leads that will be acted on, with their names. */
  leads: { id: string; firstName: string | null; lastName: string | null }[];
  skipped: Record<string, number>;
  changes?: PreviewChange[];
  note?: string;
}): ActionPreview {
  const { leads, skipped } = opts;
  const left = skippedLine(skipped);
  if (leads.length === 0) throw new AppError('CONFLICT', `None of these leads can be changed: ${left}.`);
  const sample = leads.slice(0, SAMPLE).map(nameOf);
  const more = leads.length - sample.length;
  return {
    title: opts.title(leads.length),
    changes: [{ field: 'Leads', from: null, to: `${leads.length}` }, ...(opts.changes ?? [])],
    summary: [
      `Includes ${sample.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
      ...(left ? [`Left out: ${left}.`] : []),
      ...(opts.note ? [opts.note] : []),
      ...(leads.length > TYPED_CONFIRM_ABOVE ? ['It runs in the background; the card shows progress and can stop it.'] : []),
    ].join(' '),
    bulk: { leadIds: leads.map((l) => l.id), skipped, sample },
  };
}

/** Counts a reason for leaving a lead out. */
export const skip = (skipped: Record<string, number>, why: string) => {
  skipped[why] = (skipped[why] ?? 0) + 1;
};

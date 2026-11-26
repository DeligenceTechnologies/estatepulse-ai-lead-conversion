import type { Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import type { GuardedPrisma } from '@/common/prisma/prisma.service';
import { OUTSIDE_IMPORT_REVIEW, fullName, visibleLeads } from '@/lead/lead-scope';
import type { RefTable } from './refs';

/** Leads the user may see that are not still waiting in import or consent review, plus any extra filter. */
export const visible = (auth: AuthContext, extra: Prisma.LeadWhereInput = {}): Prisma.LeadWhereInput => ({
  AND: [{ ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW }, extra],
});

/** The lead behind a ref, if the user may see it and it is not still waiting in import or consent review. */
export async function findVisibleLead<S extends Prisma.LeadSelect>(prisma: GuardedPrisma, auth: AuthContext, refs: RefTable, ref: string, select: S) {
  const id = await refs.resolve('lead', ref);
  const lead = await prisma.lead.findFirst({ where: visible(auth, { id }), select });
  if (!lead) throw new AppError('NOT_FOUND', `${ref} is still waiting in import or consent review. Finish the review on the Leads screen first.`);
  return lead as Prisma.LeadGetPayload<{ select: S }>;
}

export const leadName = (l: { firstName: string | null; lastName: string | null }): string => fullName(l.firstName, l.lastName, 'this lead');

/** The office's time zone, which meeting times are shown in. */
export async function officeTimezone(prisma: GuardedPrisma, orgId: string): Promise<string> {
  const settings = await prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } });
  return settings?.timezone || 'UTC';
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** "$450,000" for a card, so a budget is read at a glance. */
export const money = (value: number | string | { toString(): string } | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? USD.format(n) : String(value);
};

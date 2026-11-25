import { AssignmentType, LeadStatus, LeadTemperature, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import type { PrismaService } from '@/common/prisma/prisma.service';
import type { LeadAssignmentService } from '@/lead/lead-assignment.service';
import type { LeadEditService } from '@/lead/lead-edit.service';
import type { LeadReviewService } from '@/lead/lead-review.service';
import { INACTIVE_STATUSES } from '@/lead/lead-status';
import { AGENT_ROLE_WHERE, OUTSIDE_IMPORT_REVIEW, fullName, visibleLeads } from '@/lead/lead-scope';
import { liveReviewReasons } from '@/lead/review-reasons';
import type { ManualLeadService } from '@/lead/manual-lead.service';
import { PERMISSIONS } from '@/role/permissions';
import { findLeads } from './lead-search';
import { leadRef, refOf, userRef, type RefTable } from './refs';
import { display, readTool, writeTool, type AssistantTool, type PreviewChange } from './tool';

export interface LeadToolDeps {
  prisma: PrismaService;
  edits: LeadEditService;
  assignments: LeadAssignmentService;
  manualLeads: ManualLeadService;
  reviews: LeadReviewService;
}

const MAX_BUDGET = 9_999_999_999;
const DAY_MS = 24 * 60 * 60 * 1000;

const text = (max: number) => z.string().trim().max(max);
const clearable = (max: number) =>
  text(max)
    .transform((v) => v || null)
    .nullable()
    .optional();
const budget = z.number().int().min(0).max(MAX_BUDGET);

const LEAD_SUMMARY = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  status: true,
  temperature: true,
  score: true,
  location: true,
  lastContactAt: true,
  createdAt: true,
  leadSource: { select: { name: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.LeadSelect;

const LEAD_DETAIL = {
  ...LEAD_SUMMARY,
  followUpReason: true,
  callbackAt: true,
  aiSummary: true,
  memorySummary: true,
  buyingIntent: true,
  timeline: true,
  minBudget: true,
  maxBudget: true,
  financingStatus: true,
  bedrooms: true,
  motivation: true,
  timezone: true,
  consentStatus: true,
  dncStatus: true,
  automationPaused: true,
  needsReview: true,
  reviewReasons: true,
  phoneValid: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

type LeadSummaryRow = Prisma.LeadGetPayload<{ select: typeof LEAD_SUMMARY }>;

/** What the model sees of a lead: its ref, never its id. */
const toSummary = (l: LeadSummaryRow, leads: Map<string, string>, users: Map<string, string>) => ({
  ref: leads.get(l.id)!,
  name: fullName(l.firstName, l.lastName, 'Unnamed lead'),
  phone: l.phone,
  email: l.email,
  status: l.status,
  temperature: l.temperature,
  score: l.score === null ? null : Number(l.score),
  location: l.location,
  source: l.leadSource?.name ?? null,
  assignedTo: l.assignedTo ? { ref: users.get(l.assignedTo.id)!, name: fullName(l.assignedTo.firstName, l.assignedTo.lastName) } : null,
  lastContactAt: l.lastContactAt,
  createdAt: l.createdAt,
});

async function summaries(refs: RefTable, rows: LeadSummaryRow[]) {
  const [leads, users] = await Promise.all([
    refs.issue('lead', rows.map((l) => l.id)),
    refs.issue('user', rows.flatMap((l) => (l.assignedTo ? [l.assignedTo.id] : []))),
  ]);
  return rows.map((l) => toSummary(l, leads, users));
}

/** Rows for ids a search already scoped to the user, in the order given. */
async function summaryRows(prisma: PrismaService, orgId: string, ids: string[]): Promise<LeadSummaryRow[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.lead.findMany({ where: { id: { in: ids }, orgId }, select: LEAD_SUMMARY });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

const MATCH_NOTE = {
  ambiguous: (n: number) =>
    n === 1
      ? 'Not a close match. Check with the user that this is the person they mean before acting.'
      : 'More than one lead could be meant. If the user means one person, ask which one before acting.',
  none: 'No lead matches that.',
};

const visible = (auth: AuthContext, extra: Prisma.LeadWhereInput = {}): Prisma.LeadWhereInput => ({
  AND: [{ ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW }, extra],
});

/** The lead behind a ref, if the user may see it and it is not still waiting in import or consent review. */
async function findVisibleLead<S extends Prisma.LeadSelect>(prisma: PrismaService, auth: AuthContext, refs: RefTable, ref: string, select: S) {
  const id = await refs.resolve('lead', ref);
  const lead = await prisma.lead.findFirst({ where: visible(auth, { id }), select });
  if (!lead) throw new AppError('NOT_FOUND', `${ref} is still waiting in import or consent review. Finish the review on the Leads screen first.`);
  return lead as Prisma.LeadGetPayload<{ select: S }>;
}

const UPDATE_FIELDS = {
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: clearable(100),
  phone: clearable(50),
  email: z.email().max(255).nullable().optional(),
  location: clearable(255),
  timeline: clearable(100),
  minBudget: budget.nullable().optional(),
  maxBudget: budget.nullable().optional(),
  bedrooms: z.number().int().min(0).max(50).nullable().optional(),
  financingStatus: clearable(100).describe('e.g. pre_approved, cash_buyer, needs_lender, not_preapproved'),
  notes: clearable(2000).describe("Free-text notes; stored as the lead's motivation"),
};

type UpdateField = keyof typeof UPDATE_FIELDS;

const CURRENT_FIELD: Record<UpdateField, keyof Prisma.LeadGetPayload<{ select: typeof LEAD_DETAIL }>> = {
  firstName: 'firstName',
  lastName: 'lastName',
  phone: 'phone',
  email: 'email',
  location: 'location',
  timeline: 'timeline',
  minBudget: 'minBudget',
  maxBudget: 'maxBudget',
  bedrooms: 'bedrooms',
  financingStatus: 'financingStatus',
  notes: 'motivation',
};

const FIELD_LABEL: Record<UpdateField, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  phone: 'Phone',
  email: 'Email',
  location: 'Location',
  timeline: 'Timeline',
  minBudget: 'Budget min',
  maxBudget: 'Budget max',
  bedrooms: 'Bedrooms',
  financingStatus: 'Financing',
  notes: 'Notes',
};

const leadUpdateInput = z.object({ lead: leadRef, ...UPDATE_FIELDS }).strict();
const leadCreateInput = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: text(100).optional(),
    phone: text(50).optional(),
    email: z.email().max(255).optional(),
    location: text(255).optional(),
    timeline: text(100).optional(),
    minBudget: budget.optional(),
    maxBudget: budget.optional(),
    bedrooms: z.number().int().min(0).max(50).optional(),
    notes: text(2000).optional(),
    consent: z.boolean().describe('True only if the user said the lead agreed to be called and texted'),
    startOutreach: z.boolean().describe('True only if the user asked for the AI to start contacting the lead now'),
  })
  .strict();

export function leadTools({ prisma, edits, assignments, manualLeads, reviews }: LeadToolDeps): AssistantTool[] {
  return [
    readTool({
      name: 'lead_search',
      label: 'Searching leads',
      description:
        'Find leads visible to the user. With a query (a name, phone number or email) it ranks the matches and says whether one lead clearly fits, several could, or none. Without one it lists the newest leads that pass the filters, with the total.',
      permissions: [],
      input: z
        .object({
          query: text(100).optional().describe("A person's name, phone number or email. Use the filters for anything else."),
          status: z.array(z.enum(LeadStatus)).max(Object.keys(LeadStatus).length).optional(),
          temperature: z.enum(LeadTemperature).optional(),
          location: text(100).optional().describe('Part of the area or city, e.g. "Austin"'),
          unassigned: z.boolean().optional().describe('True for leads with no agent'),
          assignedTo: userRef.optional(),
          createdAfter: z.iso.datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .strict(),
      async run({ auth, refs }, input) {
        const assignedToId = input.assignedTo && !input.unassigned ? await refs.resolve('user', input.assignedTo) : undefined;
        const where = visible(auth, {
          ...(input.status?.length ? { status: { in: input.status } } : {}),
          ...(input.temperature ? { temperature: input.temperature } : {}),
          ...(input.location ? { location: { contains: input.location, mode: 'insensitive' } } : {}),
          ...(input.unassigned ? { assignedToId: null } : assignedToId ? { assignedToId } : {}),
          ...(input.createdAfter ? { createdAt: { gte: new Date(input.createdAfter) } } : {}),
        });

        const q = input.query?.trim();
        if (!q) {
          const [total, rows] = await Promise.all([
            prisma.lead.count({ where }),
            prisma.lead.findMany({ where, select: LEAD_SUMMARY, orderBy: { createdAt: 'desc' }, take: input.limit }),
          ]);
          return { total, leads: await summaries(refs, rows) };
        }

        const found = await findLeads(prisma, where, q, input.limit);
        const leads = await summaries(refs, await summaryRows(prisma, auth.organizationId, found.ids));
        const closest = await summaries(refs, await summaryRows(prisma, auth.organizationId, found.closest));
        return {
          match: found.match,
          ...(found.match === 'ambiguous' ? { note: MATCH_NOTE.ambiguous(found.total) } : found.match === 'none' ? { note: MATCH_NOTE.none } : {}),
          total: found.total,
          leads,
          ...(closest.length ? { closest: closest.map(({ ref, name, location }) => ({ ref, name, location })) } : {}),
        };
      },
    }),

    readTool({
      name: 'lead_get',
      label: 'Opening lead',
      description: 'Full details of one lead: contact, status, what they are looking for, AI notes, consent and review state.',
      permissions: [],
      input: z.object({ lead: leadRef }).strict(),
      async run({ auth, refs }, input) {
        const l = await findVisibleLead(prisma, auth, refs, input.lead, LEAD_DETAIL);
        const [summary] = await summaries(refs, [l]);
        return {
          ...summary,
          followUpReason: l.followUpReason,
          callbackAt: l.callbackAt,
          aiSummary: l.aiSummary,
          memory: l.memorySummary,
          buyingIntent: l.buyingIntent,
          timeline: l.timeline,
          budget: { min: l.minBudget === null ? null : Number(l.minBudget), max: l.maxBudget === null ? null : Number(l.maxBudget) },
          financingStatus: l.financingStatus,
          bedrooms: l.bedrooms,
          notes: l.motivation,
          timezone: l.timezone,
          consentStatus: l.consentStatus,
          doNotContact: l.dncStatus,
          automationPaused: l.automationPaused,
          needsReview: l.needsReview,
          reviewReasons: liveReviewReasons(l),
          updatedAt: l.updatedAt,
        };
      },
    }),

    readTool({
      name: 'lead_stats',
      label: 'Counting leads',
      description: 'Counts of visible leads by status and temperature, the total, and how many arrived in the last 1, 7 and 30 days.',
      permissions: [],
      input: z.object({}).strict(),
      async run({ auth }) {
        const where = visible(auth);
        const since = (days: number) => prisma.lead.count({ where: visible(auth, { createdAt: { gte: new Date(Date.now() - days * DAY_MS) } }) });
        const [byStatus, byTemperature, total, unassigned, last1, last7, last30] = await Promise.all([
          prisma.lead.groupBy({ by: ['status'], where, _count: { _all: true } }),
          prisma.lead.groupBy({ by: ['temperature'], where, _count: { _all: true } }),
          prisma.lead.count({ where }),
          prisma.lead.count({ where: visible(auth, { assignedToId: null }) }),
          since(1),
          since(7),
          since(30),
        ]);
        return {
          total,
          unassigned,
          newLeads: { last24h: last1, last7d: last7, last30d: last30 },
          byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
          byTemperature: Object.fromEntries(byTemperature.map((g) => [g.temperature ?? 'unrated', g._count._all])),
        };
      },
    }),

    readTool({
      name: 'team_list',
      label: 'Looking up the team',
      description: 'Agents who can be given leads, with how many active leads each holds and their cap.',
      permissions: [PERMISSIONS.LEAD_READ],
      input: z.object({}).strict(),
      async run({ auth, refs }) {
        const orgId = auth.organizationId;
        const agents = await prisma.user.findMany({
          where: { orgId, status: 'active', roles: { some: { role: AGENT_ROLE_WHERE } } },
          select: { id: true, firstName: true, lastName: true, email: true, maxActiveLeads: true },
          orderBy: { firstName: 'asc' },
        });
        const active = await prisma.lead.groupBy({
          by: ['assignedToId'],
          where: { orgId, mergedIntoId: null, assignedToId: { in: agents.map((a) => a.id) }, status: { notIn: INACTIVE_STATUSES } },
          _count: { _all: true },
        });
        const counts = new Map(active.map((g) => [g.assignedToId, g._count._all]));
        const userRefs = await refs.issue('user', agents.map((a) => a.id));
        return agents.map((a) => ({
          ref: userRefs.get(a.id)!,
          name: fullName(a.firstName, a.lastName, a.email),
          email: a.email,
          activeLeads: counts.get(a.id) ?? 0,
          maxActiveLeads: a.maxActiveLeads,
        }));
      },
    }),

    writeTool({
      name: 'lead_update',
      label: 'Preparing lead update',
      description:
        "Correct a lead's own details. Send only the fields to change; null clears a field. Status, assignment and consent are not changed here.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: leadUpdateInput,
      async preview({ auth, refs }, input) {
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, LEAD_DETAIL);
        const changes: PreviewChange[] = [];
        for (const field of Object.keys(UPDATE_FIELDS) as UpdateField[]) {
          if (input[field] === undefined) continue;
          const from = display(lead[CURRENT_FIELD[field]]);
          const to = display(input[field]);
          if (from !== to) changes.push({ field: FIELD_LABEL[field], from, to });
        }
        if (changes.length === 0) throw new AppError('VALIDATION_ERROR', 'Those values are already on the lead; nothing would change.');
        return {
          title: `Update ${fullName(lead.firstName, lead.lastName, 'lead')}`,
          changes,
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, { lead, ...fields }) {
        const result = await edits.update(auth, await refs.resolve('lead', lead), fields);
        return { updated: Object.keys(result.changed), becameDoNotContact: result.becameDoNotContact };
      },
    }),

    writeTool({
      name: 'lead_assign',
      label: 'Preparing assignment',
      description: "Give a lead to an agent from team_list. Respects each agent's lead cap.",
      permissions: [PERMISSIONS.LEAD_ASSIGN],
      input: z.object({ lead: leadRef, agent: userRef }).strict(),
      async preview({ auth, refs }, input) {
        const agentId = await refs.resolve('user', input.agent);
        const [lead, agent] = await Promise.all([
          findVisibleLead(prisma, auth, refs, input.lead, { ...LEAD_SUMMARY, updatedAt: true }),
          prisma.user.findFirst({ where: { id: agentId, orgId: auth.organizationId }, select: { firstName: true, lastName: true, email: true } }),
        ]);
        if (!agent) throw new AppError('NOT_FOUND', 'No such agent in this organization.');
        return {
          title: `Assign ${fullName(lead.firstName, lead.lastName, 'lead')}`,
          changes: [
            {
              field: 'Agent',
              from: lead.assignedTo ? fullName(lead.assignedTo.firstName, lead.assignedTo.lastName) : 'Unassigned',
              to: fullName(agent.firstName, agent.lastName, agent.email),
            },
          ],
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const [leadId, agentId] = await Promise.all([refs.resolve('lead', input.lead), refs.resolve('user', input.agent)]);
        const result = await assignments.assign(auth.organizationId, leadId, agentId, {
          actorType: 'ai',
          actorId: auth.userId,
          assignmentType: AssignmentType.manual,
          reason: 'Assigned through Ask EstatePulse',
        });
        return { agent: result.agent.name, changed: result.changed };
      },
    }),

    writeTool({
      name: 'lead_create',
      label: 'Preparing new lead',
      description:
        'Add one lead by hand. Needs a first name and a phone or email. Ask the user about consent and outreach; never assume either is true.',
      permissions: [PERMISSIONS.LEAD_IMPORT],
      input: leadCreateInput,
      async preview(_ctx, input) {
        if (!input.phone && !input.email) throw new AppError('VALIDATION_ERROR', 'A lead needs a phone number or an email address.');
        const rows: [string, unknown][] = [
          ['Name', fullName(input.firstName, input.lastName)],
          ['Phone', input.phone],
          ['Email', input.email],
          ['Location', input.location],
          ['Timeline', input.timeline],
          ['Budget', input.minBudget !== undefined || input.maxBudget !== undefined ? `${input.minBudget ?? '?'} – ${input.maxBudget ?? '?'}` : null],
          ['Bedrooms', input.bedrooms],
          ['Notes', input.notes],
          ['Consent to call/text', input.consent ? 'Yes' : 'No'],
          ['Start AI outreach now', input.startOutreach ? 'Yes' : 'No'],
        ];
        return {
          title: 'Create lead',
          changes: rows.filter(([, v]) => display(v) !== null).map(([field, v]) => ({ field, from: null, to: display(v) })),
        };
      },
      async run({ auth, refs }, input) {
        const created = await manualLeads.create(auth.organizationId, auth.userId, input);
        return {
          ref: await refOf(refs, 'lead', created.id),
          // Set when the phone or email already belonged to a lead: that lead was used instead of a new one.
          ...(created.matchedBy ? { matchedExistingLeadBy: created.matchedBy } : {}),
        };
      },
    }),

    writeTool({
      name: 'lead_review_approve',
      label: 'Preparing review approval',
      description: 'Approve a lead flagged for review. Its review reasons clear and, if it can be contacted, outreach starts.',
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z.object({ lead: leadRef }).strict(),
      async preview({ auth, refs }, input) {
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, LEAD_DETAIL);
        const reasons = liveReviewReasons(lead);
        if (!lead.needsReview || reasons.length === 0) throw new AppError('CONFLICT', 'This lead is not waiting for review.');
        return {
          title: `Approve ${fullName(lead.firstName, lead.lastName, 'lead')}`,
          summary: `Clears: ${reasons.join(', ')}. Outreach starts if the lead can be contacted.`,
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        return reviews.approve(auth.organizationId, auth.userId, await refs.resolve('lead', input.lead));
      },
    }),
  ];
}

export async function leadVersion(prisma: PrismaService, orgId: string, id: string): Promise<Date | null> {
  const lead = await prisma.lead.findFirst({ where: { id, orgId }, select: { updatedAt: true } });
  return lead?.updatedAt ?? null;
}

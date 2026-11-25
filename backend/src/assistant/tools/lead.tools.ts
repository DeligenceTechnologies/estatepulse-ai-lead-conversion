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

const leadId = z.uuid().describe('Lead id from lead_search or lead_get');
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
  lastContactAt: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

type LeadSummaryRow = Prisma.LeadGetPayload<{ select: typeof LEAD_SUMMARY }>;

const toSummary = (l: LeadSummaryRow) => ({
  id: l.id,
  name: fullName(l.firstName, l.lastName, 'Unnamed lead'),
  phone: l.phone,
  email: l.email,
  status: l.status,
  temperature: l.temperature,
  score: l.score === null ? null : Number(l.score),
  location: l.location,
  source: l.leadSource?.name ?? null,
  assignedTo: l.assignedTo ? { id: l.assignedTo.id, name: fullName(l.assignedTo.firstName, l.assignedTo.lastName) } : null,
  createdAt: l.createdAt,
});

const visible = (auth: AuthContext, extra: Prisma.LeadWhereInput = {}): Prisma.LeadWhereInput => ({
  AND: [{ ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW }, extra],
});

async function findVisibleLead<S extends Prisma.LeadSelect>(prisma: PrismaService, auth: AuthContext, id: string, select: S) {
  const lead = await prisma.lead.findFirst({ where: visible(auth, { id }), select });
  if (!lead) throw new AppError('NOT_FOUND', 'No lead with that id is visible to this user.');
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

const leadUpdateInput = z.object({ leadId, ...UPDATE_FIELDS }).strict();
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
        'Find leads visible to the user. Matches name, phone, email or location, with optional filters. Returns at most `limit` leads plus the total that match.',
      permissions: [],
      input: z
        .object({
          query: text(100).optional().describe('Name, phone, email or location to match'),
          status: z.array(z.enum(LeadStatus)).max(Object.keys(LeadStatus).length).optional(),
          temperature: z.enum(LeadTemperature).optional(),
          unassigned: z.boolean().optional().describe('True for leads with no agent'),
          assignedToId: z.uuid().optional().describe('Agent id from team_list'),
          createdAfter: z.iso.datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .strict(),
      async run({ auth }, input) {
        const q = input.query?.trim();
        const where = visible(auth, {
          ...(input.status?.length ? { status: { in: input.status } } : {}),
          ...(input.temperature ? { temperature: input.temperature } : {}),
          ...(input.unassigned ? { assignedToId: null } : input.assignedToId ? { assignedToId: input.assignedToId } : {}),
          ...(input.createdAfter ? { createdAt: { gte: new Date(input.createdAfter) } } : {}),
          ...(q
            ? {
                OR: [
                  ...q
                    .split(/\s+/)
                    .slice(0, 3)
                    .flatMap((part) => [
                      { firstName: { contains: part, mode: 'insensitive' as const } },
                      { lastName: { contains: part, mode: 'insensitive' as const } },
                    ]),
                  { email: { contains: q, mode: 'insensitive' } },
                  { phone: { contains: q } },
                  { normalizedPhone: { contains: q.replace(/[^\d+]/g, '') || q } },
                  { location: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        });
        const [total, rows] = await Promise.all([
          prisma.lead.count({ where }),
          prisma.lead.findMany({ where, select: LEAD_SUMMARY, orderBy: { createdAt: 'desc' }, take: input.limit }),
        ]);
        return { total, leads: rows.map(toSummary) };
      },
    }),

    readTool({
      name: 'lead_get',
      label: 'Opening lead',
      description: 'Full details of one lead: contact, status, what they are looking for, AI notes, consent and review state.',
      permissions: [],
      input: z.object({ leadId }).strict(),
      async run({ auth }, input) {
        const l = await findVisibleLead(prisma, auth, input.leadId, LEAD_DETAIL);
        return {
          ...toSummary(l),
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
          lastContactAt: l.lastContactAt,
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
      async run({ auth }) {
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
        return agents.map((a) => ({
          id: a.id,
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
      async preview({ auth }, input) {
        const lead = await findVisibleLead(prisma, auth, input.leadId, LEAD_DETAIL);
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
      async run({ auth }, { leadId: id, ...fields }) {
        const result = await edits.update(auth, id, fields);
        return { updated: Object.keys(result.changed), becameDoNotContact: result.becameDoNotContact };
      },
    }),

    writeTool({
      name: 'lead_assign',
      label: 'Preparing assignment',
      description: "Give a lead to an agent from team_list. Respects each agent's lead cap.",
      permissions: [PERMISSIONS.LEAD_ASSIGN],
      input: z.object({ leadId, agentId: z.uuid().describe('Agent id from team_list') }).strict(),
      async preview({ auth }, input) {
        const [lead, agent] = await Promise.all([
          findVisibleLead(prisma, auth, input.leadId, { ...LEAD_SUMMARY, updatedAt: true }),
          prisma.user.findFirst({ where: { id: input.agentId, orgId: auth.organizationId }, select: { firstName: true, lastName: true, email: true } }),
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
      async run({ auth }, input) {
        const result = await assignments.assign(auth.organizationId, input.leadId, input.agentId, {
          actorType: 'ai',
          actorId: auth.userId,
          assignmentType: AssignmentType.manual,
          reason: 'Assigned through Copilot',
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
      async run({ auth }, input) {
        return manualLeads.create(auth.organizationId, auth.userId, input);
      },
    }),

    writeTool({
      name: 'lead_review_approve',
      label: 'Preparing review approval',
      description: 'Approve a lead flagged for review. Its review reasons clear and, if it can be contacted, outreach starts.',
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z.object({ leadId }).strict(),
      async preview({ auth }, input) {
        const lead = await findVisibleLead(prisma, auth, input.leadId, LEAD_DETAIL);
        const reasons = liveReviewReasons(lead);
        if (!lead.needsReview || reasons.length === 0) throw new AppError('CONFLICT', 'This lead is not waiting for review.');
        return {
          title: `Approve ${fullName(lead.firstName, lead.lastName, 'lead')}`,
          summary: `Clears: ${reasons.join(', ')}. Outreach starts if the lead can be contacted.`,
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth }, input) {
        return reviews.approve(auth.organizationId, auth.userId, input.leadId);
      },
    }),
  ];
}

export async function leadVersion(prisma: PrismaService, orgId: string, id: string): Promise<Date | null> {
  const lead = await prisma.lead.findFirst({ where: { id, orgId }, select: { updatedAt: true } });
  return lead?.updatedAt ?? null;
}

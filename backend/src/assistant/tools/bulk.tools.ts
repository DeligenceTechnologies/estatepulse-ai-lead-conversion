import { AssignmentType, ConsentStatus, EnrollmentStatus, FollowUpReason, LeadStatus, SequenceStatus } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '@/common/errors/app-error';
import type { GuardedPrisma } from '@/common/prisma/prisma.service';
import type { FollowupService } from '@/followup/followup.service';
import type { LeadAssignmentService } from '@/lead/lead-assignment.service';
import { INACTIVE_STATUSES, IN_STRATEGY_STATUSES } from '@/lead/lead-status';
import { fullName } from '@/lead/lead-scope';
import { liveReviewReasons } from '@/lead/review-reasons';
import { PERMISSIONS } from '@/role/permissions';
import type { EngineService } from '@/telnyx/engine.service';
import type { OutreachControlService } from '@/telnyx/outreach-control.service';
import { bulkCard, bulkSelection, selectLeads, skip } from './bulk';
import { STATUS_LABEL, statusEffect } from './outreach.tools';
import { sequenceRef, userRef } from './refs';
import { writeTool, type AssistantTool } from './tool';

export interface BulkToolDeps {
  prisma: GuardedPrisma;
  assignments: LeadAssignmentService;
  engine: EngineService;
  followup: FollowupService;
  control: OutreachControlService;
}

const LIVE_ENROLLMENT = [EnrollmentStatus.active, EnrollmentStatus.paused];
const BACKGROUND = 'Runs in a background job, one lead at a time.';

/** Bulk tools never run in the chat turn; the job calls bulk.runOne per lead. */
const notInline = async (): Promise<never> => {
  throw new Error('A bulk action runs in its background job.');
};

const selection = <T extends z.ZodRawShape>(extra: T) => z.object({ ...bulkSelection, ...extra }).strict();

export function bulkTools({ prisma, assignments, engine, followup, control }: BulkToolDeps): AssistantTool[] {
  return [
    writeTool({
      name: 'leads_assign',
      label: 'Preparing to assign leads',
      description: `Give many leads to one agent from team_list: leads named by ref, or every lead matching a filter (up to 500). ${BACKGROUND} An agent at their lead cap refuses the rest.`,
      permissions: [PERMISSIONS.LEAD_ASSIGN],
      input: selection({ agent: userRef }),
      async preview({ auth, refs }, input) {
        const orgId = auth.organizationId;
        const agentId = await refs.resolve('user', input.agent);
        const agent = await prisma.user.findFirst({ where: { id: agentId, orgId }, select: { firstName: true, lastName: true, email: true, maxActiveLeads: true } });
        if (!agent) throw new AppError('NOT_FOUND', 'No such agent in this organization.');
        const name = fullName(agent.firstName, agent.lastName, agent.email);
        const rows = await selectLeads(prisma, auth, refs, input, { assignedToId: true });
        const skipped: Record<string, number> = {};
        const leads = rows.filter((l) => (l.assignedToId === agentId ? (skip(skipped, `already with ${name}`), false) : true));
        let note: string | undefined;
        if (agent.maxActiveLeads !== null) {
          const holds = await prisma.lead.count({ where: { orgId, assignedToId: agentId, mergedIntoId: null, status: { notIn: INACTIVE_STATUSES } } });
          const room = Math.max(0, agent.maxActiveLeads - holds);
          if (leads.length > room) note = `${name} has room for ${room} more (cap ${agent.maxActiveLeads}); leads beyond that are refused.`;
        }
        return bulkCard({ title: (n) => `Assign ${n} lead${n === 1 ? '' : 's'} to ${name}`, leads, skipped, changes: [{ field: 'Agent', from: null, to: name }], note });
      },
      run: notInline,
      bulk: {
        async runOne({ auth, refs }, input, leadId) {
          const agentId = await refs.resolve('user', input.agent);
          const result = await assignments.assign(auth.organizationId, leadId, agentId, {
            actorType: 'ai',
            actorId: auth.userId,
            assignmentType: AssignmentType.manual,
            reason: 'Assigned through Ask EstatePulse',
          });
          return result.changed ? undefined : { skipped: 'already with the agent' };
        },
      },
    }),

    writeTool({
      name: 'leads_set_status',
      label: 'Preparing status changes',
      description: `Move many leads to one pipeline status: leads named by ref, or every lead matching a filter (up to 500). ${BACKGROUND}`,
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: selection({
        status: z.enum(LeadStatus),
        reason: z.string().trim().max(500).optional(),
        followUpReason: z.enum(FollowUpReason).optional().describe('Only with status follow_up'),
      }),
      async preview({ auth, refs }, input) {
        const rows = await selectLeads(prisma, auth, refs, input, { status: true });
        const skipped: Record<string, number> = {};
        const label = STATUS_LABEL[input.status];
        const leads = rows.filter((l) => (l.status === input.status ? (skip(skipped, `already ${label}`), false) : true));
        return bulkCard({
          title: (n) => `Move ${n} lead${n === 1 ? '' : 's'} to ${label}`,
          leads,
          skipped,
          changes: [{ field: 'Status', from: null, to: label }, ...(input.reason ? [{ field: 'Reason', from: null, to: input.reason }] : [])],
          note: statusEffect(input.status),
        });
      },
      run: notInline,
      bulk: {
        async runOne({ auth }, input, leadId) {
          const changed = await engine.setStatus(auth.organizationId, leadId, input.status, input.reason, {
            followUpReason: input.status === LeadStatus.follow_up ? input.followUpReason : undefined,
            actor: { type: 'user', id: auth.userId },
            source: 'assistant',
          });
          return changed ? undefined : { skipped: 'the status could not change' };
        },
      },
    }),

    writeTool({
      name: 'leads_sequence_enroll',
      label: 'Preparing the sequence',
      description: `Add many leads to one active follow-up sequence from sequence_list: leads named by ref, or every lead matching a filter (up to 500). ${BACKGROUND} Leads still in the outreach strategy, already in a sequence, paused or opted out are left out.`,
      permissions: [PERMISSIONS.AUTOMATION_UPDATE],
      input: selection({ sequence: sequenceRef }),
      async preview({ auth, refs }, input) {
        const orgId = auth.organizationId;
        const sequence = await followup.getSequence(orgId, await refs.resolve('sequence', input.sequence));
        if (sequence.status !== SequenceStatus.active) throw new AppError('CONFLICT', `"${sequence.name}" is not active, so nothing can be added to it.`);
        if (sequence.steps.length === 0) throw new AppError('CONFLICT', `"${sequence.name}" has no steps yet.`);
        const rows = await selectLeads(prisma, auth, refs, input, { dncStatus: true, automationPaused: true, status: true, firstContactAt: true });
        const enrolled = new Set(
          (await prisma.sequenceEnrollment.findMany({ where: { orgId, leadId: { in: rows.map((r) => r.id) }, status: { in: LIVE_ENROLLMENT } }, select: { leadId: true } })).map((e) => e.leadId),
        );
        const skipped: Record<string, number> = {};
        const leads = rows.filter((l) => {
          if (l.dncStatus) skip(skipped, 'opted out');
          else if (enrolled.has(l.id)) skip(skipped, 'already in a sequence');
          else if (l.automationPaused) skip(skipped, 'with outreach paused');
          else if (l.firstContactAt && IN_STRATEGY_STATUSES.includes(l.status)) skip(skipped, 'still in the outreach strategy');
          else return true;
          return false;
        });
        return bulkCard({
          title: (n) => `Add ${n} lead${n === 1 ? '' : 's'} to "${sequence.name}"`,
          leads,
          skipped,
          changes: [{ field: 'Sequence', from: null, to: `${sequence.name} (${sequence.steps.length} steps)` }],
          note: "Each lead's status becomes follow-up.",
        });
      },
      run: notInline,
      bulk: {
        async runOne({ auth, refs }, input, leadId) {
          const sequenceId = await refs.resolve('sequence', input.sequence);
          const result = await followup.enrollLeads(auth.organizationId, sequenceId, { leadIds: [leadId] }, auth.userId);
          return result.enrolled === 1 ? undefined : { skipped: (result.skipped[0]?.reason ?? 'not added').replace(/_/g, ' ') };
        },
      },
    }),

    writeTool({
      name: 'leads_outreach_pause',
      label: 'Preparing to pause outreach',
      description: `Pause AI outreach for many leads: leads named by ref, or every lead matching a filter (up to 500). Each can be resumed later with leads_outreach_resume. ${BACKGROUND}`,
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: selection({ reason: z.string().trim().max(300).optional() }),
      async preview({ auth, refs }, input) {
        const rows = await selectLeads(prisma, auth, refs, input, { automationPaused: true, dncStatus: true });
        const skipped: Record<string, number> = {};
        const leads = rows.filter((l) => {
          if (l.automationPaused) skip(skipped, 'already paused');
          else if (l.dncStatus) skip(skipped, 'opted out');
          else return true;
          return false;
        });
        return bulkCard({
          title: (n) => `Pause AI outreach to ${n} lead${n === 1 ? '' : 's'}`,
          leads,
          skipped,
          changes: input.reason ? [{ field: 'Reason', from: null, to: input.reason }] : [],
          note: 'Strategy steps, sequences and promised texts hold until resumed. If a lead texts, the AI still answers.',
        });
      },
      run: notInline,
      bulk: {
        async runOne({ auth }, input, leadId) {
          await control.pause(auth, leadId, { source: 'assistant', reason: input.reason });
        },
      },
    }),

    writeTool({
      name: 'leads_outreach_resume',
      label: 'Preparing to resume outreach',
      description: `Resume paused AI outreach for many leads: leads named by ref, or every lead matching a filter (up to 500). Each carries on where it stopped. ${BACKGROUND}`,
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: selection({}),
      async preview({ auth, refs }, input) {
        const rows = await selectLeads(prisma, auth, refs, input, {
          automationPaused: true,
          dncStatus: true,
          consentStatus: true,
          needsReview: true,
          reviewReasons: true,
          phone: true,
          phoneValid: true,
        });
        const skipped: Record<string, number> = {};
        const leads = rows.filter((l) => {
          if (!l.automationPaused) skip(skipped, 'not paused');
          else if (l.dncStatus) skip(skipped, 'opted out');
          else if (l.consentStatus === ConsentStatus.revoked) skip(skipped, 'withdrew consent');
          else if (l.needsReview && liveReviewReasons(l).length > 0) skip(skipped, 'waiting for review');
          else return true;
          return false;
        });
        return bulkCard({ title: (n) => `Resume AI outreach to ${n} lead${n === 1 ? '' : 's'}`, leads, skipped, note: 'Each lead carries on from where its outreach stopped.' });
      },
      run: notInline,
      bulk: {
        async runOne({ auth }, _input, leadId) {
          await control.resume(auth, leadId, { source: 'assistant' });
        },
      },
    }),
  ];
}

import { ConsentStatus, EnrollmentStatus, FollowUpReason, LeadStatus, SequenceStatus } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '@/common/errors/app-error';
import type { GuardedPrisma } from '@/common/prisma/prisma.service';
import type { FollowupService } from '@/followup/followup.service';
import { INACTIVE_STATUSES, IN_STRATEGY_STATUSES } from '@/lead/lead-status';
import { PERMISSIONS } from '@/role/permissions';
import type { EngineService } from '@/telnyx/engine.service';
import type { OutreachControlService } from '@/telnyx/outreach-control.service';
import type { StrategyStoreService } from '@/telnyx/strategy-store.service';
import { sent } from './calendar.tools';
import { findVisibleLead, leadName } from './lead-access';
import { MAX_TEXT, TEXT_LEAD, sendLeadText, textBlocker, textNotes, type LeadTextDeps } from './lead-text';
import { leadRef, refOf, sequenceRef } from './refs';
import { readTool, writeTool, type AssistantTool } from './tool';

export interface OutreachToolDeps {
  prisma: GuardedPrisma;
  engine: EngineService;
  strategies: StrategyStoreService;
  followup: FollowupService;
  control: OutreachControlService;
  text: LeadTextDeps;
}

const LIVE_ENROLLMENT = [EnrollmentStatus.active, EnrollmentStatus.paused];

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  contacting: 'Contacting',
  engaged: 'Engaged',
  follow_up: 'Follow-up',
  interested: 'Interested',
  appointment_requested: 'Appointment requested',
  appointment_booked: 'Appointment booked',
  not_interested: 'Not interested',
  unresponsive: 'Unresponsive',
  closed: 'Closed',
  invalid: 'Invalid',
};

const label = (s: LeadStatus) => STATUS_LABEL[s];

/** What a status change sets off, for the card. */
function statusEffect(status: LeadStatus): string | undefined {
  if (INACTIVE_STATUSES.includes(status)) return 'AI outreach and follow-up sequences for this lead stop.';
  if (status === LeadStatus.follow_up) return "AI outreach stops, and the lead joins the follow-up sequence set up for the reason, if there is one.";
  if (!IN_STRATEGY_STATUSES.includes(status)) return 'AI outreach for this lead stops.';
  return undefined;
}

/** "after 2 days", for a sequence step's delay. */
function after(minutes: number): string {
  if (minutes <= 0) return 'right away';
  if (minutes < 60) return `after ${minutes} min`;
  if (minutes < 24 * 60) return `after ${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / (24 * 60));
  return `after ${days} day${days === 1 ? '' : 's'}`;
}

export function outreachTools(deps: OutreachToolDeps): AssistantTool[] {
  const { prisma } = deps;

  return [
    writeTool({
      name: 'text_send',
      label: 'Preparing the text',
      description:
        "Send a lead an SMS from the office number, in the user's name. Write the exact words; the user sees them on the card. Only within texting hours on the lead's clock, and never to a lead who opted out.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z
        .object({
          lead: leadRef,
          text: z.string().trim().min(1).max(MAX_TEXT).describe('The exact words to send'),
        })
        .strict(),
      async preview({ auth, refs }, input) {
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, TEXT_LEAD);
        const blocked = await textBlocker(deps.text, auth, lead);
        if (blocked) throw new AppError('CONFLICT', blocked);
        return {
          title: `Text ${leadName(lead)}`,
          changes: [
            { field: 'To', from: null, to: lead.phone },
            { field: 'Message', from: null, to: input.text },
          ],
          summary: textNotes(auth, lead),
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        // Checked again: the card may have waited into quiet hours, or the lead opted out meanwhile.
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, TEXT_LEAD);
        const blocked = await textBlocker(deps.text, auth, lead);
        if (blocked) throw new AppError('CONFLICT', `Not sent. ${blocked}`);
        return sent(await sendLeadText(deps.text, auth, lead, input.text), await refOf(refs, 'lead', lead.id));
      },
    }),

    writeTool({
      name: 'lead_set_status',
      label: 'Preparing status change',
      description:
        "Move a lead to another pipeline status, as a person would on the lead's page. Statuses that end or pause the journey stop AI outreach.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z
        .object({
          lead: leadRef,
          status: z.enum(LeadStatus),
          reason: z.string().trim().max(500).optional().describe('Why, in a few words, when the user gave a reason'),
          followUpReason: z.enum(FollowUpReason).optional().describe('Only with status follow_up'),
        })
        .strict(),
      async preview({ auth, refs }, input) {
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, { id: true, firstName: true, lastName: true, status: true, updatedAt: true });
        if (lead.status === input.status) throw new AppError('VALIDATION_ERROR', `${leadName(lead)} is already ${label(input.status)}.`);
        return {
          title: `Change ${leadName(lead)}'s status`,
          changes: [
            { field: 'Status', from: label(lead.status), to: label(input.status) },
            ...(input.reason ? [{ field: 'Reason', from: null, to: input.reason }] : []),
          ],
          summary: statusEffect(input.status),
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        const changed = await deps.engine.setStatus(auth.organizationId, leadId, input.status, input.reason, {
          followUpReason: input.status === LeadStatus.follow_up ? input.followUpReason : undefined,
          actor: { type: 'user', id: auth.userId },
          source: 'assistant',
        });
        return { status: input.status, changed };
      },
    }),

    writeTool({
      name: 'outreach_start',
      label: 'Preparing outreach',
      description: "Start the office's AI outreach strategy (calls and texts) for a lead that has not been contacted yet.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z.object({ lead: leadRef }).strict(),
      async preview({ auth, refs }, input) {
        const orgId = auth.organizationId;
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, {
          id: true,
          firstName: true,
          lastName: true,
          dncStatus: true,
          consentStatus: true,
          automationPaused: true,
          firstContactAt: true,
          updatedAt: true,
        });
        if (lead.dncStatus) throw new AppError('CONFLICT', 'This lead asked not to be contacted.');
        if (lead.consentStatus === ConsentStatus.revoked) throw new AppError('CONFLICT', 'This lead withdrew consent to be contacted.');
        if (lead.firstContactAt) {
          throw new AppError('CONFLICT', `Outreach already started for this lead on ${lead.firstContactAt.toISOString().slice(0, 10)}. To reach them now, send a text.`);
        }
        if (lead.automationPaused) {
          throw new AppError('CONFLICT', 'Outreach is paused for this lead (it may have replied, be waiting for consent, or an agent took over its chat), so it cannot start from here.');
        }
        if (!(await deps.engine.canReachLeads(orgId))) throw new AppError('CONFLICT', 'Connect a phone number in AI Settings before starting outreach.');
        const strategy = await deps.strategies.getStrategy(orgId);
        return {
          title: `Start AI outreach for ${leadName(lead)}`,
          changes: [{ field: 'Strategy', from: null, to: `${strategy.name} (${strategy.steps.length} steps)` }],
          summary: [
            'The AI calls and texts the lead step by step, only within contact hours, until they respond or the steps run out.',
            ...(lead.consentStatus === ConsentStatus.pending ? ['This lead has not confirmed consent yet.'] : []),
          ].join(' '),
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        await deps.engine.enroll(auth.organizationId, leadId);
        const lead = await prisma.lead.findFirst({ where: { id: leadId, orgId: auth.organizationId }, select: { firstContactAt: true } });
        if (!lead?.firstContactAt) throw new AppError('CONFLICT', 'Outreach did not start. The lead may have been paused or contacted meanwhile.');
        return { started: true };
      },
    }),

    writeTool({
      name: 'outreach_pause',
      label: 'Preparing to pause outreach',
      description:
        "Pause a lead's AI outreach: the strategy's next steps, its follow-up sequences and any text the AI promised. Nothing is lost; outreach_resume carries each on where it stopped. If the lead texts meanwhile, the AI still answers.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z.object({ lead: leadRef, reason: z.string().trim().max(300).optional() }).strict(),
      async preview({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        const { lead, lines, notes } = await deps.control.pausePlan(auth, leadId);
        return {
          title: `Pause AI outreach to ${leadName(lead)}`,
          changes: [
            { field: 'Pauses', from: null, to: lines.join('; ') },
            ...(input.reason ? [{ field: 'Reason', from: null, to: input.reason }] : []),
          ],
          summary: [...notes, 'Resume it any time.'].join(' '),
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        return deps.control.pause(auth, leadId, { source: 'assistant', reason: input.reason });
      },
    }),

    writeTool({
      name: 'outreach_resume',
      label: 'Preparing to resume outreach',
      description:
        "Lift a pause on a lead's AI outreach, whoever or whatever paused it: the strategy goes on from its next step (or starts, for a lead never contacted), paused sequences go on, and a promised text still ahead is put back.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z.object({ lead: leadRef }).strict(),
      async preview({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        const { lead, lines, notes } = await deps.control.resumePlan(auth, leadId);
        return {
          title: `Resume AI outreach to ${leadName(lead)}`,
          changes: [{ field: 'Restarts', from: null, to: lines.join('; ') || 'Nothing right away' }],
          ...(notes.length ? { summary: notes.join(' ') } : {}),
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const leadId = await refs.resolve('lead', input.lead);
        return { resumed: true, ...(await deps.control.resume(auth, leadId, { source: 'assistant' })) };
      },
    }),

    readTool({
      name: 'sequence_list',
      label: 'Looking up sequences',
      description: "The office's follow-up sequences: what each sends and when, whether it is active, and how many leads are in it.",
      permissions: [PERMISSIONS.AUTOMATION_READ],
      input: z.object({}).strict(),
      async run({ auth, refs }) {
        const sequences = await deps.followup.listSequences(auth.organizationId);
        const sequenceRefs = await refs.issue('sequence', sequences.map((s) => s.id));
        return sequences.map((s) => ({
          ref: sequenceRefs.get(s.id)!,
          name: s.name,
          description: s.description,
          status: s.status,
          startsWhen: s.enrollTriggers,
          steps: s.steps.map((step) => `${step.actionType === 'sms' ? 'text' : 'AI call'} ${after(step.delayMinutes)}`),
          leadsActive: s.activeCount,
        }));
      },
    }),

    writeTool({
      name: 'sequence_enroll',
      label: 'Preparing the sequence',
      description: 'Add one lead to an active follow-up sequence from sequence_list. A lead can be in one sequence at a time, and not while the outreach strategy is still running.',
      permissions: [PERMISSIONS.AUTOMATION_UPDATE],
      input: z.object({ lead: leadRef, sequence: sequenceRef }).strict(),
      async preview({ auth, refs }, input) {
        const orgId = auth.organizationId;
        const [lead, sequenceId] = await Promise.all([
          findVisibleLead(prisma, auth, refs, input.lead, { id: true, firstName: true, lastName: true, automationPaused: true, updatedAt: true }),
          refs.resolve('sequence', input.sequence),
        ]);
        const sequence = await deps.followup.getSequence(orgId, sequenceId);
        if (sequence.status !== SequenceStatus.active) throw new AppError('CONFLICT', `"${sequence.name}" is not active, so nothing can be added to it.`);
        if (sequence.steps.length === 0) throw new AppError('CONFLICT', `"${sequence.name}" has no steps yet.`);
        if (lead.automationPaused) throw new AppError('CONFLICT', 'Outreach is stopped or paused for this lead, so a sequence would send nothing.');
        const current = await prisma.sequenceEnrollment.findFirst({
          where: { orgId, leadId: lead.id, status: { in: LIVE_ENROLLMENT } },
          select: { sequence: { select: { name: true } } },
        });
        if (current) throw new AppError('CONFLICT', `${leadName(lead)} is already in "${current.sequence.name}". One sequence at a time.`);
        const check = await deps.followup.enrollLeads(orgId, sequenceId, { leadIds: [lead.id], dryRun: true }, auth.userId);
        const skip = check.skipped[0];
        if (skip?.reason === 'dnc') throw new AppError('CONFLICT', 'This lead asked not to be contacted.');
        if (skip?.reason === 'in_strategy') {
          throw new AppError('CONFLICT', 'The lead is still in the AI outreach strategy, so it cannot join a sequence yet. Moving it to follow-up ends the strategy.');
        }
        const first = sequence.steps[0];
        return {
          title: `Add ${leadName(lead)} to "${sequence.name}"`,
          changes: [{ field: 'Sequence', from: null, to: `${sequence.name} (${sequence.steps.length} steps)` }],
          summary: `The first ${first.actionType === 'sms' ? 'text' : 'AI call'} goes ${after(first.delayMinutes)}, within contact hours. The lead's status becomes follow-up.`,
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const [leadId, sequenceId] = await Promise.all([refs.resolve('lead', input.lead), refs.resolve('sequence', input.sequence)]);
        const result = await deps.followup.enrollLeads(auth.organizationId, sequenceId, { leadIds: [leadId] }, auth.userId);
        if (result.enrolled !== 1) {
          throw new AppError('CONFLICT', `The lead was not added (${result.skipped[0]?.reason ?? 'unknown reason'}).`);
        }
        return { enrolled: true };
      },
    }),
  ];
}

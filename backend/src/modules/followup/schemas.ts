import { z } from 'zod';

/**
 * zod through ZodValidationPipe, matching agents/schemas.ts — the service
 * receives the PARSED value, so a trimmed name and a coerced number are
 * guaranteed rather than hoped for.
 *
 * Several of these bounds are not style choices: they mirror CHECK constraints
 * and column widths that already exist in the database and are NOT represented
 * in schema.prisma. Validating here turns a 500 from Postgres into a 400 that
 * names the field. Each one says which constraint it shadows.
 */

/** sequence_steps_action_check. 'call' is not a legal value — it is 'voice'. */
export const actionTypeSchema = z.enum(['sms', 'voice']);

/** followup_sequences_status_check. */
export const sequenceStatusSchema = z.enum(['active', 'inactive', 'archived']);

/** followup_sequences_auto_enroll_check, plus null for manual-only. */
export const autoEnrollSchema = z.enum(['hot', 'warm', 'cold']).nullable();

/**
 * What has to happen to a lead for it to be enrolled automatically.
 *
 * Verbatim from sequence_enroll_triggers_trigger_check — a value this enum
 * allows and the constraint does not would be a 500 naming a constraint nobody
 * has heard of, and a value the constraint allows and this does not is a
 * condition the office can never switch on.
 *
 * The three `qualified_*` values replace the old `auto_enroll_temperature`
 * column one for one. The `follow_up_*` values are the follow-up reasons
 * (FollowUpReason, common/domain): a lead parked in follow_up for that reason
 * is enrolled.
 */
export const enrollTriggerSchema = z.enum([
  'qualified_hot',
  'qualified_warm',
  'qualified_cold',
  'follow_up_no_answer',
  'follow_up_not_ready',
  'follow_up_callback_requested',
  'follow_up_needs_time',
  'follow_up_other',
]);

/**
 * The set a sequence claims. Empty is the default and means manual-only — a
 * newly saved sequence must never start swallowing leads because somebody
 * pressed Save.
 *
 * Deduplicated rather than rejected for duplicates: the same box ticked twice
 * is a UI accident, not something worth a 400 over, and the unique index would
 * otherwise turn it into a confusing conflict with the sequence itself.
 */
export const enrollTriggersSchema = z
  .array(enrollTriggerSchema)
  .max(8)
  .transform((xs) => [...new Set(xs)])
  .default([]);

const stepSchema = z
  .object({
    actionType: actionTypeSchema,
    // sequence_steps_delay_check is `>= 0`, but a zero-delay nurture step fires
    // the instant the previous one does, which is never what anyone means and
    // reads to the lead as a double text. One minute is the floor.
    //
    // The ceiling is a year: a gap longer than that is a typo (someone typing
    // days into a minutes box), and the cost of accepting it is a lead who
    // hears nothing for a decade.
    delayMinutes: z.coerce.number().int().min(1).max(525_600),
    // messages.body is unbounded TEXT, but a single SMS segment is 160 chars
    // and carriers split beyond that. 1600 is ten segments — generous, while
    // still catching a pasted essay.
    messageTemplate: z.string().trim().max(1600).optional().nullable(),
    voicePrompt: z.string().trim().max(2000).optional().nullable(),
    // sequence_steps_attempts_check is `> 0`.
    maxAttempts: z.coerce.number().int().min(1).max(10).default(1),
  })
  .strict()
  .refine((s) => (s.actionType === 'sms' ? !!s.messageTemplate?.trim() : true), {
    message: 'An SMS step needs a message',
    path: ['messageTemplate'],
  })
  .refine((s) => (s.actionType === 'voice' ? !!s.voicePrompt?.trim() : true), {
    message: 'An AI callback step needs a prompt',
    path: ['voicePrompt'],
  });

/**
 * Step order is the array index, never a field the client sends. Letting the
 * client pick it invites duplicates, which `sequence_steps_order_unique`
 * rejects with a 500 that names an index nobody has heard of.
 */
export const stepsSchema = z
  .array(stepSchema)
  .min(1, 'A sequence needs at least one step')
  .max(20, 'Twenty steps is already far more than anyone reads');

export const createSequenceSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    // followup_sequences.code is varchar(50) and unique per organization. It is
    // the stable handle the API and the seeds use, so it is upper snake case
    // and cannot be changed afterwards.
    code: z
      .string()
      .trim()
      .min(2)
      .max(50)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Code must be UPPER_SNAKE_CASE'),
    description: z.string().trim().max(2000).optional(),
    status: sequenceStatusSchema.default('active'),
    enrollTriggers: enrollTriggersSchema,
    steps: stepsSchema,
  })
  .strict();

/** Everything editable after creation. `code` is deliberately absent. */
export const updateSequenceSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: sequenceStatusSchema.optional(),
    enrollTriggers: z.array(enrollTriggerSchema).max(8).transform((xs) => [...new Set(xs)]).optional(),
  })
  .strict();

export const replaceStepsSchema = z.object({ steps: stepsSchema }).strict();

/**
 * Who to add, in bulk.
 *
 * Every field narrows; an empty filter matches every lead in the organization,
 * which is why the endpoint requires a dry run to have been possible and caps
 * what one call may enrol. The conditions are the four groups asked for:
 * temperature/status, source/date, engagement, and free text.
 */
export const leadFilterSchema = z
  .object({
    temperature: z.enum(['hot', 'warm', 'cold']).optional(),
    status: z.string().trim().max(30).optional(),
    sourceId: z.string().uuid().optional(),
    createdFrom: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
    createdTo: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
    /** Never replied to anything — leads.first_response_at IS NULL. */
    noReply: z.coerce.boolean().optional(),
    /** Never contacted at all — leads.last_contact_at IS NULL. */
    neverContacted: z.coerce.boolean().optional(),
    /** Name or phone, the same substring match the call history uses. */
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const enrollSchema = z
  .object({
    /** Hand-picked. Mutually exclusive with `filter`. */
    leadIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    filter: leadFilterSchema.optional(),
    /** Resolve and report who WOULD be added, writing nothing. */
    dryRun: z.coerce.boolean().default(false),
  })
  .strict()
  .refine((b) => !!b.leadIds !== !!b.filter, {
    message: 'Send either leadIds or filter, not both and not neither',
  });

export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;
export type ReplaceStepsInput = z.infer<typeof replaceStepsSchema>;
export type EnrollInput = z.infer<typeof enrollSchema>;
export type LeadFilterInput = z.infer<typeof leadFilterSchema>;
export type EnrollTrigger = z.infer<typeof enrollTriggerSchema>;

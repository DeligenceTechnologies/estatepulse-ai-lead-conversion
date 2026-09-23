import { z } from 'zod';
import { emailSchema, passwordSchema, requiredTimezoneSchema, timezoneSchema } from '../../auth/schemas';

/**
 * zod rather than class-validator, matching auth/schemas.ts: these shapes are
 * validated through ZodValidationPipe, which returns the PARSED value, so the
 * service receives a trimmed, lower-cased email rather than whatever arrived.
 *
 * `.strict()` is load-bearing, not decoration. It is what rejects
 * `{"role": "owner"}` and `{"organizationId": "<someone else's org>"}` with a
 * 400 instead of silently ignoring them. The service never reads either field —
 * role is hardcoded and the organization comes from the session — so strictness
 * is belt-and-braces, but it turns a privilege-escalation ATTEMPT into a visible
 * error rather than a request that appears to succeed.
 */
/**
 * agent_profiles.max_active_leads is an int4 with a CHECK (max_active_leads > 0).
 * `.positive()` is that constraint restated where the caller gets a 400 instead
 * of a 500, and the upper bound is the column's own range — exceeding it is a
 * Postgres numeric-overflow error, not a product rule, so the bound is int4's
 * and nothing narrower is invented here.
 */
const maxActiveLeadsSchema = z
  .number()
  .int('Lead cap must be a whole number')
  .positive('Lead cap must be at least 1')
  .max(2_147_483_647);

export const createAgentSchema = z
  .object({
    email: emailSchema,
    // Same rule as signup. An owner setting an agent's first password is still
    // setting a password.
    password: passwordSchema,
    firstName: z.string().trim().min(1, 'First name is required').max(100),
    lastName: z.string().trim().min(1, 'Last name is required').max(100),
    // users.phone and agent_profiles.phone are both nullable varchar(50).
    // Display only — nothing dials it — so it is stored as typed rather than
    // normalised through libphonenumber the way an inbound lead's phone is.
    phone: z.string().trim().max(50).optional(),
    // Detected from the creating owner's browser, not typed in. Absent is fine:
    // the service then inherits the organization's timezone.
    timezone: timezoneSchema,
    // Optional so an older client that does not send it still creates an agent —
    // the column default (25) then stands, which is the same value the form
    // shows. Same rule as the edit path, so an agent cannot be onboarded with a
    // cap the edit form would reject.
    maxActiveLeads: maxActiveLeadsSchema.optional(),
  })
  .strict();

/**
 * Name rules, shared by create and update so an agent cannot be edited into a
 * shape the create form would have rejected. Same spelling as signupSchema.
 */
const firstNameSchema = z.string().trim().min(1, 'First name is required').max(100);
const lastNameSchema = z.string().trim().min(1, 'Last name is required').max(100);

/**
 * Nullable rather than merely optional: absent means "leave it alone", null
 * means "clear it". Without the distinction there is no way to remove a phone
 * number that was entered by mistake. '' is folded to null in the service, the
 * same rule create() already applies.
 */
const optionalTextSchema = (max: number) => z.string().trim().max(max).nullable();

/** The profile fields an owner may edit. Every one maps to an existing column. */
const PROFILE_KEYS = ['firstName', 'lastName', 'email', 'phone', 'title', 'timezone', 'maxActiveLeads'] as const;

/**
 * One PATCH body for two different edits, because they address the same
 * resource and the client should not have to know which table a field lives in.
 *
 * `status` is the membership switch that already existed; the rest is the agent's
 * profile. They are deliberately NOT combinable in one request: suspension has
 * authorization rules of its own (no self-suspension, no suspending an owner)
 * and a body that did both would have to half-apply when one of them is refused.
 * The UI sends them from two different controls anyway.
 *
 * `.strict()` is load-bearing, exactly as on createAgentSchema: it is what
 * rejects `{"role":"owner"}`, `{"organizationId":"..."}`, `{"status":"active",
 * "routingEnabled":false}` and `{"password":"..."}` with a 400 rather than
 * ignoring them silently. The service reads none of those fields — role and
 * organization are not editable here and a password is set nowhere but create —
 * so strictness turns an escalation ATTEMPT into a visible error.
 */
export const updateAgentSchema = z
  .object({
    /**
     * The two membership mutations that exist: 'suspended' locks a member out,
     * 'active' puts them back. An enum of exactly these two rather than of every
     * status the column permits - 'invited' would be an invitation flow, which
     * is not built, so it is not accepted.
     *
     * Reinstatement matters as much as suspension: without it a misclick is
     * only recoverable with direct SQL.
     */
    status: z.enum(['suspended', 'active']).optional(),
    firstName: firstNameSchema.optional(),
    lastName: lastNameSchema.optional(),
    email: emailSchema.optional(),
    /** users.phone and agent_profiles.phone are both varchar(50), nullable. */
    phone: optionalTextSchema(50).optional(),
    /** agent_profiles.title, varchar(100), nullable. */
    title: optionalTextSchema(100).optional(),
    /**
     * Picked from a form here, so the strict rule applies: an unknown zone is a
     * 400, never a silent no-op. See requiredTimezoneSchema.
     */
    timezone: requiredTimezoneSchema.optional(),
    maxActiveLeads: maxActiveLeadsSchema.optional(),
  })
  .strict()
  // An empty body is a 400 rather than a successful no-op: a PATCH that changed
  // nothing but answered 200 reads to the client as a save that worked.
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update',
  })
  .refine((body) => !(body.status !== undefined && PROFILE_KEYS.some((k) => body[k] !== undefined)), {
    message: 'Change the membership status or the profile, not both in one request',
  });

/** True when this body is the membership switch rather than a profile edit. */
export const isStatusUpdate = (
  input: UpdateAgentInput,
): input is UpdateAgentInput & { status: 'suspended' | 'active' } => input.status !== undefined;

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

import { z } from 'zod';
import { emailSchema, passwordSchema } from '../../auth/schemas';

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
  })
  .strict();

/**
 * Suspension is the only membership mutation in this phase. A literal rather
 * than an enum of every status the column permits: 'active' would be a
 * reinstate flow and 'invited' an invitation flow, and neither is built, so
 * neither is accepted.
 */
export const updateAgentSchema = z
  .object({
    status: z.literal('suspended'),
  })
  .strict();

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

import { z } from 'zod';

/**
 * bcrypt silently truncates beyond 72 bytes, so anything longer is rejected
 * outright rather than quietly accepted as a shorter password.
 *
 * Exported because every place that SETS a password must apply the same rule —
 * signup here, and an owner creating an agent in modules/agents. Two copies of
 * a password policy is two policies.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Password must be at most 72 bytes');

export const emailSchema = z.string().trim().toLowerCase().email('Must be a valid email address').max(255);

/**
 * The IANA list worth trusting is the one the runtime actually has: ICU throws
 * RangeError for a zone it does not know. No table to keep in sync.
 */
const isValidTimeZone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Detected by the browser, never asked for, so a client that cannot supply one
 * (no ICU data, a non-browser caller, an older client) must not be turned away:
 * anything absent or unrecognised collapses to undefined and the caller's own
 * fallback stands. max(100) matches both timezone columns.
 *
 * Exported because every place that SETS a timezone must apply the same rule -
 * signup here, and an owner creating an agent in modules/agents.
 */
export const timezoneSchema = z.string().trim().max(100).refine(isValidTimeZone).optional().catch(undefined);

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  organizationName: z.string().trim().min(1, 'Organization name is required').max(255),
  timezone: timezoneSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  // No length rules on login: an old password that predates a rule change must
  // still be able to authenticate, and the rules leak policy to attackers.
  password: z.string().min(1, 'Password is required'),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

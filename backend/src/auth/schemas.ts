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

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  organizationName: z.string().trim().min(1, 'Organization name is required').max(255),
});

export const loginSchema = z.object({
  email: emailSchema,
  // No length rules on login: an old password that predates a rule change must
  // still be able to authenticate, and the rules leak policy to attackers.
  password: z.string().min(1, 'Password is required'),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

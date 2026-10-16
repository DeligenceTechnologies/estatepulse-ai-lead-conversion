import { z } from 'zod';
import type { CustomConfig } from './auth';
import { CUSTOM_TARGETS, MAX_CUSTOM_NAME } from './mapping';
import { MAX_PATH_CHARS } from './constants';

/** An HTTP header name. Stored lowercase: that is how Express hands headers back. */
const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'A header name is letters, digits and dashes')
  .transform((s) => s.toLowerCase());

export const authSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('header_secret'), headerName }),
  z.object({
    mode: z.literal('hmac'),
    headerName,
    algorithm: z.enum(['sha256', 'sha1']).default('sha256'),
    encoding: z.enum(['hex', 'base64']).default('hex'),
    prefix: z.string().trim().max(16).optional(),
  }),
  z.object({ mode: z.literal('basic'), username: z.string().trim().min(1).max(100) }),
]);
export type AuthBody = z.infer<typeof authSchema>;

export const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  auth: authSchema.default({ mode: 'none' }),
  deliveryIdHeader: headerName.optional(),
});
export type CreateBody = z.infer<typeof createSchema>;

/** lead_sources.custom_config as stored. */
export const configSchema = z.object({
  auth: authSchema,
  deliveryIdHeader: headerName.optional(),
  dropped: z.number().int().min(0).optional(),
  activated: z.boolean().optional(),
});

/** Null when the column holds nothing readable; callers fail closed on null. */
export function parseConfig(raw: unknown): CustomConfig | null {
  const parsed = configSchema.safeParse(raw);
  return parsed.success ? (parsed.data as CustomConfig) : null;
}

export const updateAuthSchema = z.object({
  auth: authSchema,
  deliveryIdHeader: headerName.nullable().optional(),
});
export type UpdateAuthBody = z.infer<typeof updateAuthSchema>;

/** The option map a choice question carries; the only transform an owner may send. */
const enumMapTransform = z.object({
  kind: z.literal('enum_map'),
  byOptionText: z
    .record(z.string().min(1).max(200), z.string().min(1).max(100))
    .refine((m) => Object.keys(m).length <= 100, 'At most 100 options'),
  fallback: z.string().max(100).nullable().optional(),
});

const field = z.object({
  path: z.string().trim().min(1).max(MAX_PATH_CHARS),
  target: z.enum(CUSTOM_TARGETS),
  customName: z.string().trim().min(1).max(MAX_CUSTOM_NAME).optional(),
  transform: enumMapTransform.optional(),
});

export const fieldsSchema = z.array(field).min(1).max(100);

export const saveMappingSchema = z.object({ fields: fieldsSchema });
export type SaveMappingBody = z.infer<typeof saveMappingSchema>;

/** A dry run: with `fields`, the draft on screen; without, the saved mapping. */
export const testSchema = z.object({ fields: fieldsSchema.optional() }).default({});
export type TestBody = z.infer<typeof testSchema>;

import { z } from 'zod';

/**
 * Parsed and validated once at import time. Any problem here is fatal: a
 * backend that boots with a missing or placeholder JWT_SECRET is worse than
 * one that refuses to boot.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL is required'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((v) => !v.includes('CHANGE_ME'), 'JWT_SECRET is still the placeholder from .env.example'),
  JWT_ISSUER: z.string().min(1).default('estatepulse'),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Comma-separated exact origins. Empty in dev, where the Vite proxy makes
  // the API same-origin and CORS never comes into play.
  CORS_ORIGINS: z.string().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProduction: parsed.data.NODE_ENV === 'production',
};

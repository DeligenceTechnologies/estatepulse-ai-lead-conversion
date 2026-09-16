import { defineConfig } from 'vitest/config';

/**
 * Unit suites only — files named *.spec.ts.
 *
 * src/auth/auth.test.ts is deliberately out of scope: it is an integration
 * suite that boots the portal against the real database and needs the env file
 * loaded into the process. It runs under node:test via `npm run test:auth`,
 * which passes --env-file. Vitest's default glob would pick it up and fail at
 * import time on env validation.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});

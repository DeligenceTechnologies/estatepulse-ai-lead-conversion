import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit suites only — files named *.spec.ts.
 *
 * src/auth/auth.test.ts is deliberately out of scope: it is an integration
 * suite that boots the portal against the real database and needs the env file
 * loaded into the process. It runs under node:test via `npm run test:auth`,
 * which passes --env-file. Vitest's default glob would pick it up and fail at
 * import time on env validation.
 *
 * The swc transform is here for one reason: vitest's default esbuild transform
 * silently drops `emitDecoratorMetadata`. Nest reads constructor dependencies
 * from exactly that metadata, so any test that stands a module up with
 * `Test.createTestingModule` gets its providers injected as `undefined` — the
 * failure surfaces as "cannot read properties of undefined", far from the cause.
 * `nest build` (plain tsc) emits it correctly, so this only ever affected tests,
 * never the running app.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // Mirrors the `@/*` path in tsconfig.json.
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['src/**/*.spec.ts'],
  },
});

import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration suites — files named *.int.ts. They run against the database in
 * backend/.env (loaded by dotenv), create their own organizations and delete
 * them afterwards. One file at a time: suites share that database. The swc
 * transform is here for the same reason as in vitest.config.ts.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['src/**/*.int.ts'],
    setupFiles: ['dotenv/config'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

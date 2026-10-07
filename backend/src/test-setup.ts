/**
 * Preloaded with --require so NODE_ENV is set before the Nest container boots.
 * It has to run first: AuthModule reads NODE_ENV at module-configuration time to
 * decide whether the credential rate limiters are live, and the integration
 * suite performs far more signups than the hourly cap allows.
 *
 * It runs after --env-file, so this wins over whatever the env file says.
 */
process.env['NODE_ENV'] = 'test';

/**
 * Integration runs get a smaller slice of the shared Supabase session pool
 * (15 per user+db) than a dev backend, so three developers can run backends
 * and suites at the same time without exhausting it. Prisma reads the URL when
 * the client is constructed, which is after this file runs.
 */
if (process.env['DATABASE_URL']) {
  const url = new URL(process.env['DATABASE_URL']);
  url.searchParams.set('connection_limit', '2');
  process.env['DATABASE_URL'] = url.toString();
}
export {};

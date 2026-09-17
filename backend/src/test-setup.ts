/**
 * Preloaded with --require so NODE_ENV is set before the Nest container boots.
 * It has to run first: AuthModule reads NODE_ENV at module-configuration time to
 * decide whether the credential rate limiters are live, and the integration
 * suite performs far more signups than the hourly cap allows.
 *
 * It runs after --env-file, so this wins over whatever the env file says.
 */
process.env['NODE_ENV'] = 'test';
export {};

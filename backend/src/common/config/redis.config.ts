import type { RedisOptions } from 'ioredis';

export type RedisConnectionOptions = Omit<RedisOptions, 'retryStrategy'> & { retryStrategy: (attempt: number) => number };

export function redisOptions(redisUrl: string): RedisConnectionOptions {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL is not a valid URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  const db = url.pathname.replace(/^\/+/, '');
  if (db && !/^\d+$/.test(db)) throw new Error('REDIS_URL database must be a number, e.g. redis://host:6379/0');

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}),
    enableReadyCheck: true,
    connectTimeout: 10_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 500, 10_000),
  };
}

import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Dev-only request timing, OFF unless PERF_TIMING=1 — and never in production.
 *
 * Logs one line per request: route, total time, Prisma queries issued and the
 * engine time they took, and time spent authenticating. Prisma's query events
 * do not carry the request's async context, so queries are attributed to the
 * request in flight — accurate only when requests are issued one at a time and
 * the background pollers are off. See "Request timing" in the README.
 *
 * Refused under NODE_ENV=production even when asked for: it logs SQL text for
 * every query, and mis-attributes timings under concurrent traffic.
 */
export function resolvePerfEnabled(env: NodeJS.ProcessEnv): { enabled: boolean; refused: boolean } {
  const requested = env.PERF_TIMING === '1';
  const production = env.NODE_ENV === 'production';
  return { enabled: requested && !production, refused: requested && production };
}

const resolved = resolvePerfEnabled(process.env);
if (resolved.refused) {
  new Logger('PerfTiming').warn('PERF_TIMING=1 ignored: request timing is never enabled when NODE_ENV=production');
}
export const perfEnabled = resolved.enabled;

interface Stats {
  queries: number;
  dbMs: number;
  guardMs: number;
}

let current: Stats | null = null;

export function recordQuery(durationMs: number): void {
  if (current) {
    current.queries += 1;
    current.dbMs += durationMs;
  }
}

export function recordGuard(ms: number): void {
  if (current) current.guardMs += ms;
}

export function perfMiddleware(req: Request, res: Response, next: NextFunction): void {
  const stats: Stats = { queries: 0, dbMs: 0, guardMs: 0 };
  current = stats;
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const total = Number(process.hrtime.bigint() - start) / 1e6;
    if (current === stats) current = null;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ` +
        `total=${total.toFixed(0)}ms queries=${stats.queries} db=${stats.dbMs}ms guard=${stats.guardMs.toFixed(0)}ms`,
    );
  });
  next();
}

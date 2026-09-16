import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { authRouter } from './auth/routes';
import { telnyxRouter } from './telnyx/routes';
import { webhookRouter } from './telnyx/webhook';
import { ingestPublicRouter, ingestLeadsAliasRouter } from './ingest/routes';
import { env } from './env';
import { AppError, errorHandler, notFoundHandler } from './errors';

/**
 * This backend is one process serving two route families on one port:
 *
 *   - the portal (Express routers below) — auth, Telnyx/AI calling, and the
 *     simple lead webhook
 *   - the ingestion service (NestJS, see app.module.ts) — form-provider
 *     webhooks, field mapping and the processing worker
 *
 * They are separate frameworks because they were built separately, and a
 * rewrite of either would have been a rewrite of working, tested code. They
 * share this Express instance, so the split costs nothing at runtime: one
 * listener, one middleware chain, one deployment.
 *
 * Composition is split into steps because ORDER IS LOAD-BEARING. Express matches
 * middleware in registration order, and NestJS registers a catch-all 404 handler
 * of its own during init() — so anything mounted after Nest is unreachable. The
 * bootstrap in server.ts therefore interleaves them as:
 *
 *   1. createBaseApp()       cross-cutting middleware — precedes every route
 *   2. (body parser)         one parser for both halves, capturing rawBody
 *   3. mountPortalRoutes()   the Express routers
 *   4. mountErrorHandler()   translates portal errors into the error envelope
 *   5. (NestJS init)         its routes, its exception filter, its 404 catch-all
 *
 * Mounting the portal after (5) is what made every portal route 404. Putting
 * helmet or the rate limiter after (3) would leave the NestJS routes unprotected.
 */

/** Step 1: cross-cutting middleware. No body parser — NestJS installs that. */
export function createBaseApp(): express.Express {
  const app = express();

  // Without this every request reads as the proxy's address and all the
  // per-IP limiters collapse into one shared bucket. One hop, not `true`,
  // which would trust a spoofed X-Forwarded-For outright.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  // Dev goes through the Vite proxy, which makes the API same-origin, so CORS
  // only ever matters in production.
  if (env.corsOrigins.length > 0) {
    app.use(cors({ origin: env.corsOrigins, credentials: false }));
  }

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: env.NODE_ENV === 'test' ? Number.MAX_SAFE_INTEGER : 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
      },
    }),
  );

  // Method, path, status and duration only. Never the body: these routes carry
  // plaintext passwords.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const who = req.auth ? ' user=' + req.auth.userId : '';
      // originalUrl, not path: path is rewritten relative to a mounted router.
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms${who}`);
    });
    next();
  });

  return app;
}

/** Step 3: the portal's own routes. Must be mounted before NestJS init(). */
export function mountPortalRoutes(app: express.Express): void {
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/webhooks/telnyx', webhookRouter); // unauthenticated — Telnyx posts here
  app.use('/api/ingest', ingestPublicRouter); // unauthenticated — token in URL identifies the org
  app.use('/api/webhooks/leads', ingestLeadsAliasRouter); // unauthenticated alias
  app.use('/api', telnyxRouter);
}

/**
 * Step 4: the portal's error envelope.
 *
 * Only the error handler — NOT notFoundHandler, which is a normal middleware
 * and would answer every request NestJS has yet to claim. Unmatched paths fall
 * through to Nest's own 404 instead. Express dispatches a thrown error to the
 * next error handler registered after the failing middleware, so mounting this
 * directly after the portal routes catches all of them.
 */
export function mountErrorHandler(app: express.Express): void {
  app.use(errorHandler);
}

/**
 * The portal alone, with its own body parser — no NestJS, no ingestion routes.
 *
 * Used by the auth suite, which needs to boot an app on a random port without
 * standing up the Nest container or touching the ingestion tables.
 */
export function createApp(): express.Express {
  const app = createBaseApp();
  // Form webhooks (Tally et al.) can be larger than a login body.
  app.use(express.json({ limit: '512kb' }));
  mountPortalRoutes(app);
  // Standalone, so it owns the 404 too — there is no NestJS behind it here.
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

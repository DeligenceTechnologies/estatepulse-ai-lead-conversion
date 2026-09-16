import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { telnyxRouter } from './telnyx/routes.js';
import { webhookRouter } from './telnyx/webhook.js';
import { ingestPublicRouter, ingestLeadsAliasRouter } from './ingest/routes.js';
import { tallyRouter } from './tally/routes.js';
import { env } from './env.js';
import { AppError, errorHandler, notFoundHandler } from './errors.js';

export function createApp(): express.Express {
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

  // Form webhooks (Tally et al.) can be larger than a login body.
  app.use(express.json({ limit: '512kb' }));

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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/webhooks/telnyx', webhookRouter); // unauthenticated — Telnyx posts here
  app.use('/api/ingest', ingestPublicRouter); // unauthenticated — token in URL identifies the org
  app.use('/api/webhooks/leads', ingestLeadsAliasRouter); // unauthenticated alias
  app.use('/api/tally', tallyRouter); // JWT-authed bridge to the Tally-connection service
  app.use('/api', telnyxRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../env';
import { AppError, zodDetails } from '../errors';
import { requireAuth } from './requireAuth';
import { loginSchema, signupSchema } from './schemas';
import { login, signup } from './service';
import type { MeDTO } from './types';

const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();

// The integration suite performs more signups than the hourly cap allows, so
// the limiters are inert under NODE_ENV=test. They are live everywhere else.
const limited = (windowMs: number, max: number, keyByEmail = false) =>
  env.NODE_ENV === 'test'
    ? passthrough
    : rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Keying login on IP + email means one shared NAT cannot lock out a whole
    // office, and one account cannot be sprayed from a single address.
    keyGenerator: (req: Request): string => {
      const ip = ipKeyGenerator(req.ip ?? '');
      if (!keyByEmail) return ip;
      const body: unknown = req.body;
      const email =
        typeof body === 'object' && body !== null && typeof (body as { email?: unknown }).email === 'string'
          ? (body as { email: string }).email.trim().toLowerCase()
          : '';
      return ip + '|' + email;
    },
        handler: (_req, _res, next) => {
          next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
        },
      });

export const authRouter = Router();

authRouter.post(
  '/signup',
  limited(60 * 60 * 1000, 3),
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('VALIDATION_ERROR', 'Invalid signup details', zodDetails(parsed.error)));
      return;
    }

    signup(parsed.data)
      .then((session) => res.status(201).json(session))
      .catch(next);
  },
);

authRouter.post(
  '/login',
  limited(15 * 60 * 1000, 5, true),
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('VALIDATION_ERROR', 'Invalid login details', zodDetails(parsed.error)));
      return;
    }

    login(parsed.data)
      .then((session) => res.status(200).json(session))
      .catch(next);
  },
);

// Returns no token: /me never refreshes or reissues a session.
authRouter.get('/me', limited(60 * 1000, 60), requireAuth, (req: Request, res: Response): void => {
  const auth = req.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Invalid token');

  const body: MeDTO = {
    user: auth.user,
    organization: auth.organization,
    role: auth.role,
    agentProfileId: auth.agentProfileId,
  };
  res.status(200).json(body);
});

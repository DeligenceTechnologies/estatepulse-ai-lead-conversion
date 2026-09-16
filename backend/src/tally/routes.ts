import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth/requireAuth.js';
import { tallyFetch } from './client.js';

/**
 * Portal-facing bridge for the Tally connection. Every route is JWT-authed and
 * forwards to the teammate's service with the org's x-api-key. Paths mirror
 * their frontend's client.ts so the connect flow is a straight pass-through:
 *   connect provider -> list forms -> connect form (installs webhook, makes source).
 */
export const tallyRouter = Router();
tallyRouter.use(requireAuth);

const orgOf = (req: Request): string => req.auth!.organizationId;

const forward = (req: Request, res: Response, path: string, method = 'GET', body?: unknown) =>
  tallyFetch(orgOf(req), path, { method, body }).then((r) => res.status(r.status).json(r.body));

// Providers + connections
tallyRouter.get('/providers', (req, res) => void forward(req, res, '/v1/integrations/providers'));
tallyRouter.get('/connections', (req, res) => void forward(req, res, '/v1/integrations'));

// Connect a Tally account (carries the raw Tally API key, POST body only)
tallyRouter.post('/connect', (req, res) => {
  const { apiKey, label } = req.body ?? {};
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'apiKey is required' } });
    return;
  }
  void forward(req, res, '/v1/integrations', 'POST', { provider: 'TALLY', apiKey, label });
});

tallyRouter.post('/connections/:id/verify', (req, res) =>
  void forward(req, res, `/v1/integrations/${encodeURIComponent(req.params.id)}/verify`, 'POST'));

tallyRouter.delete('/connections/:id', (req, res) => {
  const force = req.query.force === 'true';
  void forward(req, res, `/v1/integrations/${encodeURIComponent(req.params.id)}?force=${force}`, 'DELETE');
});

// Forms on a connected account
tallyRouter.get('/connections/:id/forms', (req, res) => {
  const cursor = req.query.cursor ? `?cursor=${encodeURIComponent(String(req.query.cursor))}` : '';
  void forward(req, res, `/v1/integrations/${encodeURIComponent(req.params.id)}/forms${cursor}`);
});

// Connect a form: installs the webhook + creates the lead source
tallyRouter.post('/lead-sources/connect', (req, res) => {
  const { credentialId, externalFormId, name } = req.body ?? {};
  if (!credentialId || !externalFormId) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'credentialId and externalFormId are required' } });
    return;
  }
  void forward(req, res, '/v1/lead-sources/connect', 'POST', { credentialId, externalFormId, name });
});

// Connected sources
tallyRouter.get('/lead-sources', (req, res) => void forward(req, res, '/v1/lead-sources'));
tallyRouter.delete('/lead-sources/:id', (req, res) => {
  const force = req.query.force === 'true';
  void forward(req, res, `/v1/lead-sources/${encodeURIComponent(req.params.id)}?force=${force}`, 'DELETE');
});

/**
 * Transparent passthrough for the rest of the service's /v1 surface.
 *
 * The named routes above cover the connect flow the portal's own Tally card
 * uses. The full dashboard (Lead Sources) needs the rest of it — deliveries,
 * secret rotation, pause, resync/reinstall, leads, health — and those are a
 * straight proxy with no reshaping, so they are forwarded wholesale rather than
 * restated one by one. Mounted last: nothing above it starts with /v1.
 *
 * Still behind requireAuth and still server-side, so the org's x-api-key never
 * reaches the browser.
 */
tallyRouter.use('/v1', (req: Request, res: Response) => {
  // req.url is the remainder after the /v1 mount point, query string included.
  const path = `/v1${req.url}`;
  const hasBody = !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method);
  void forward(req, res, path, req.method, hasBody ? (req.body ?? {}) : undefined);
});

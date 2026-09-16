import { Router, type Request, type Response } from 'express';
import { ingestLead } from './service.js';

/**
 * Public (unauthenticated) lead-ingestion webhook. Identity comes from the token
 * in the URL — never a session — so it mounts before requireAuth.
 *   POST /api/ingest/v1/tally/:token     (Tally form webhook)
 *   POST /api/ingest/v1/webhook/:token   (generic JSON)
 * Also aliased at /api/webhooks/leads/:token for the Milestone-1 doc's path.
 */
export const ingestPublicRouter = Router();

async function handle(provider: string, req: Request, res: Response): Promise<void> {
  const token = String(req.params.token ?? '');
  if (!token) {
    res.status(400).json({ error: { code: 'missing_token', message: 'Ingest token required' } });
    return;
  }
  try {
    const out = await ingestLead(token, provider, req.body);
    switch (out.kind) {
      case 'accepted':
        res.status(202).json({ received: true, leadId: out.leadId });
        return;
      case 'duplicate':
        res.status(200).json({ received: true, duplicate: true, leadId: out.leadId });
        return;
      case 'invalid':
        res.status(400).json({ error: { code: 'invalid_payload', message: 'No phone or email in payload' } });
        return;
      case 'unknown_token':
        res.status(404).json({ error: { code: 'unknown_token', message: 'Ingest token not recognized' } });
        return;
      case 'inactive':
        res.status(410).json({ error: { code: 'source_inactive', message: 'This ingest source is disabled' } });
        return;
    }
  } catch (e) {
    console.error('[ingest] handler:', (e as Error).message);
    res.status(503).json({ error: { code: 'ingest_error', message: 'Could not process submission' } });
  }
}

ingestPublicRouter.post('/v1/tally/:token', (req, res) => handle('tally', req, res));
ingestPublicRouter.post('/v1/webhook/:token', (req, res) => handle('webhook', req, res));

/** Alias for the Milestone-1 doc's path: POST /api/webhooks/leads/:token */
export const ingestLeadsAliasRouter = Router();
ingestLeadsAliasRouter.post('/:token', (req, res) => handle('webhook', req, res));

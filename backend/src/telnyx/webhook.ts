import { Router, type Request, type Response } from 'express';
import * as activity from './activity.js';

/**
 * Telnyx Call Control webhook (unauthenticated — Telnyx posts here).
 * Mounted at /api/webhooks/telnyx. Drives lead/call outcome updates:
 *   call.answered -> in_progress + lead 'contacted' + attach AI
 *   call.hangup   -> completed (if answered) or no_answer
 *
 * NOTE: signature verification is a TODO — resolve the org via client_state, then verify
 * against that org's stored public key before trusting the payload.
 */
export const webhookRouter = Router();

webhookRouter.post('/voice', (req: Request, res: Response) => {
  const data = (req.body as any)?.data;
  const type: string | undefined = data?.event_type;
  const payload = data?.payload ?? {};
  const ccid: string | undefined = payload.call_control_id;

  if (ccid && type) {
    (async () => {
      if (type === 'call.answered') await activity.onCallAnswered(ccid);
      else if (type === 'call.hangup') await activity.onCallHangup(ccid);
    })().catch((e) => console.error('[webhook] voice:', (e as Error).message));
  }
  res.sendStatus(200);
});

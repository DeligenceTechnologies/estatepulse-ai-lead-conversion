import { prisma } from '../db.js';
import { enroll } from './engine.js';

/**
 * Auto-kickoff: polls for new leads and enrolls them into their org's strategy.
 * A lead qualifies when: status='new', not paused, not DNC, and never contacted
 * (first_contact_at IS NULL — enroll sets it, so a lead is picked up exactly once).
 *
 * Only orgs that have connected their provider (a 'telnyx' integration row) are processed.
 * Gated behind STRATEGY_ENGINE=1 so it never runs by accident in a shared dev database.
 */
const INTERVAL_MS = Number(process.env.ENGINE_POLL_MS ?? 15000);
let timer: NodeJS.Timeout | null = null;

async function poll(): Promise<void> {
  try {
    const orgs = await prisma.integrations.findMany({ where: { provider: 'telnyx', status: 'active' }, select: { organization_id: true }, distinct: ['organization_id'] });
    for (const { organization_id } of orgs) {
      const leads = await prisma.leads.findMany({
        where: { organization_id, status: 'new', automation_paused: false, dnc_status: false, first_contact_at: null },
        select: { id: true },
        take: 10,
      });
      for (const lead of leads) {
        await enroll(organization_id, lead.id);
      }
    }
  } catch (err) {
    console.error('[leadWatcher] poll error:', (err as Error).message);
  }
}

export function startLeadWatcher(): void {
  if (process.env.STRATEGY_ENGINE !== '1') {
    console.log('[leadWatcher] disabled (set STRATEGY_ENGINE=1 to auto-enroll new leads)');
    return;
  }
  console.log(`[leadWatcher] watching for new leads every ${INTERVAL_MS}ms`);
  timer = setInterval(() => { void poll(); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  void poll();
}

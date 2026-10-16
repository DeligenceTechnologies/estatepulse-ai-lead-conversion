import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { EventsBus } from '../events/events.bus';
import { INGEST_PROVIDERS } from '../ingest/adapters/registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { ProcessingWorker } from './worker.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * webhook_events is shared: form deliveries (Tally, Typeform) for this worker,
 * and CRM webhooks (HubSpot) for CrmSyncService. The worker must claim every
 * form provider it can parse — a provider left out is stored and never
 * processed — and never a CRM's, which it cannot parse.
 */
function worker() {
  const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([]), $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
  const w = new ProcessingWorker(prisma as unknown as PrismaService, new ConfigService({}), {} as EventsBus);
  return { w, prisma };
}

describe('ProcessingWorker claims exactly the form providers it parses', () => {
  it('knows Tally and Typeform, and not a CRM', () => {
    expect([...INGEST_PROVIDERS].sort()).toEqual(['TALLY', 'TYPEFORM']);
    expect(INGEST_PROVIDERS).not.toContain('HUBSPOT');
  });

  it('claims PENDING deliveries of those providers only', async () => {
    const { w, prisma } = worker();
    await (w as any).claim();
    const [sql, , , providers] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/provider = ANY\(\$3::text\[\]\)/);
    expect(providers).toEqual(INGEST_PROVIDERS);
  });

  it('requeues stuck deliveries of those providers only', async () => {
    const { w, prisma } = worker();
    await (w as any).requeueStuck();
    const [sql, , providers] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/provider = ANY\(\$2::text\[\]\)/);
    expect(providers).toEqual(INGEST_PROVIDERS);
  });
});

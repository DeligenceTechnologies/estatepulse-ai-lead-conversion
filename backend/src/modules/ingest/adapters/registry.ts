import { TallyAdapter } from './tally.adapter';
import { TypeformAdapter } from './typeform.adapter';
import type { IngestAdapter } from './types';

const ADAPTERS: Record<string, IngestAdapter> = {
  TALLY: new TallyAdapter(),
  TYPEFORM: new TypeformAdapter(),
};

/**
 * Every provider whose deliveries the processing worker parses. webhook_events
 * also queues deliveries nobody here parses — a CRM's webhooks (provider
 * 'HUBSPOT'), drained by CrmSyncService under its own lease — so the worker
 * claims exactly these, and a new form provider is picked up by adding it above.
 */
export const INGEST_PROVIDERS: readonly string[] = Object.keys(ADAPTERS);

/**
 * The adapter that parses a delivery, by the provider stamped on the source or
 * the event. Rows from before providers existed carry no provider and were all
 * Tally, which is also the column default.
 */
export function ingestAdapterFor(provider: string | null | undefined): IngestAdapter {
  return ADAPTERS[(provider ?? 'TALLY').toUpperCase()] ?? ADAPTERS.TALLY;
}

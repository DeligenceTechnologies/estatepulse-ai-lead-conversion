import { TallyAdapter } from './tally.adapter';
import { TypeformAdapter } from './typeform.adapter';
import type { IngestAdapter } from './types';

const ADAPTERS: Record<string, IngestAdapter> = {
  TALLY: new TallyAdapter(),
  TYPEFORM: new TypeformAdapter(),
};

/**
 * The adapter that parses a delivery, by the provider stamped on the source or
 * the event. Rows from before providers existed carry no provider and were all
 * Tally, which is also the column default.
 */
export function ingestAdapterFor(provider: string | null | undefined): IngestAdapter {
  return ADAPTERS[(provider ?? 'TALLY').toUpperCase()] ?? ADAPTERS.TALLY;
}

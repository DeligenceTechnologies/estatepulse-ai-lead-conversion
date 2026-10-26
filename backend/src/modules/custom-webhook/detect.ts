import { ingestAdapterFor } from '../ingest/adapters/registry';
import type { IngestAdapter } from '../ingest/adapters/types';

/**
 * One URL for any app: when a payload posted to a webhook has the shape of a
 * form provider we already understand, that provider's adapter parses it —
 * stable question keys, option ids resolved to text, the same heuristics as
 * the provider's own route — and the owner only confirms the mapping. Anything
 * else is read as plain JSON paths.
 *
 * Adding a provider here is one entry: its adapter (from the ingest registry)
 * plus a cheap shape test. The tests are deliberately strict (several
 * provider-only markers each), because a false positive would send an
 * unrelated payload through the wrong parser.
 */
interface KnownShape {
  adapter: IngestAdapter;
  looksLike: (body: unknown) => boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const KNOWN_SHAPES: KnownShape[] = [
  {
    // { eventType|data.formId|data.responseId, data: { fields: [{ key, ... }] } }
    adapter: ingestAdapterFor('TALLY'),
    looksLike: (b) =>
      isRecord(b) &&
      isRecord(b.data) &&
      Array.isArray(b.data.fields) &&
      b.data.fields.every((f) => isRecord(f) && typeof f.key === 'string') &&
      (typeof b.eventType === 'string' || typeof b.data.formId === 'string' || typeof b.data.responseId === 'string'),
  },
  {
    // { event_type: "form_response", form_response: { form_id|token, answers: [...] } }
    adapter: ingestAdapterFor('TYPEFORM'),
    looksLike: (b) =>
      isRecord(b) &&
      isRecord(b.form_response) &&
      (Array.isArray(b.form_response.answers) || isRecord(b.form_response.definition)) &&
      (b.event_type === 'form_response' || typeof b.form_response.form_id === 'string' || typeof b.form_response.token === 'string'),
  },
];

/** The adapter whose shape the payload has and which parses it cleanly; null for plain JSON. */
export function detectAdapter(body: unknown): IngestAdapter | null {
  for (const shape of KNOWN_SHAPES) {
    if (!shape.looksLike(body)) continue;
    try {
      shape.adapter.parse(body);
      return shape.adapter;
    } catch {
      // Close, but not it: read it as plain JSON rather than refuse it.
    }
  }
  return null;
}

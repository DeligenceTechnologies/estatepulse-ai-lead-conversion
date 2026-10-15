import { TallyAdapter } from './tally.adapter';
import { InvalidPayloadError, type IngestAdapter, type NormalizedAnswer, type NormalizedDelivery } from './types';

const MAX_FIELDS = 100;
const MAX_VALUE_LENGTH = 2000;

/**
 * Any webhook that posts a JSON object (a website form, Zapier, Make): each
 * top-level key becomes a question, so the same field mapping and heuristics
 * that handle Tally map "name", "email" or "phone_number" here. A Tally
 * payload posted to the generic URL is still read as Tally.
 */
export class GenericWebhookAdapter implements IngestAdapter {
  readonly provider = 'WEBHOOK';
  private readonly tally = new TallyAdapter();

  parse(body: unknown): NormalizedDelivery {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new InvalidPayloadError('Expected a JSON object');
    }
    const record = body as Record<string, unknown>;
    if (record.data && typeof record.data === 'object' && Array.isArray((record.data as { fields?: unknown }).fields)) {
      return this.tally.parse(body);
    }

    const answers: NormalizedAnswer[] = [];
    for (const [key, raw] of Object.entries(record).slice(0, MAX_FIELDS)) {
      if (raw === null || raw === undefined || typeof raw === 'object') continue;
      const text = String(raw).trim().slice(0, MAX_VALUE_LENGTH);
      answers.push({
        key,
        label: key.replace(/[_-]+/g, ' ').trim(),
        type: 'INPUT_TEXT',
        raw,
        textValues: text ? [text] : [],
        scalarText: text,
      });
    }
    if (answers.length === 0) throw new InvalidPayloadError('The JSON object has no fields');

    const eventId = record.eventId ?? record.event_id ?? record.id;
    return {
      providerEventId: typeof eventId === 'string' || typeof eventId === 'number' ? String(eventId) : null,
      providerSubmissionId: null,
      providerRespondentId: null,
      providerFormId: null,
      providerFormName: null,
      eventType: 'WEBHOOK',
      submittedAt: null,
      answers,
      fields: answers.map(({ key, label, type }) => ({ key, label, type })),
      warnings: [],
    };
  }
}

export const adapterFor = (provider: string): IngestAdapter =>
  provider === 'TALLY' ? new TallyAdapter() : new GenericWebhookAdapter();

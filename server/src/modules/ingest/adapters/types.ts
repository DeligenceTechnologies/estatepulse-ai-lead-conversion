/**
 * The provider-agnostic boundary.
 *
 * Stage 1 (an adapter) is provider-specific and knows nothing about our domain.
 * Stage 2 (the mapping engine) is provider-agnostic and knows nothing about
 * Tally. Holding this line is what makes Meta Lead Ads or a generic JSON webhook
 * a small adapter later rather than a rewrite of the pipeline.
 */

export interface NormalizedAnswer {
  /** Provider's stable field key, e.g. Tally's "question_a4Xb2". */
  key: string;
  /** Current human-readable question text. Arbitrary per customer. */
  label: string;
  /** Provider field type, e.g. "INPUT_PHONE_NUMBER". Kept as a string. */
  type: string;
  /** Exactly as delivered, for debugging and replay. */
  raw: unknown;
  /**
   * Choice-field option IDs ALREADY resolved to their display text.
   *
   * This resolution happens here in stage 1 and never in a transform. It is not
   * a style preference: it is what lets `value_map` be keyed by human-readable
   * option text, which is the only thing the mapping UI can meaningfully show
   * and the only thing that survives a customer rebuilding their dropdown
   * (which mints fresh option UUIDs).
   */
  textValues: string[];
  /** textValues joined — the convenient scalar form for most transforms. */
  scalarText: string;
  /** Retained as rename-healing hints: a stable id whose text changed. */
  optionIds?: string[];
  /**
   * EVERY option the question offers, not just the ones selected.
   *
   * Required to pre-build an option-text -> enum map. Deriving that map from the
   * selected values alone produces a mapping that only covers whichever answer
   * happened to arrive first, and every other choice then silently maps to null.
   */
  allOptions?: NormalizedOption[];
}

export interface NormalizedOption {
  id: string;
  text: string;
}

export interface NormalizedField {
  key: string;
  label: string;
  type: string;
  options?: NormalizedOption[];
}

export interface AdapterWarning {
  code: string;
  fieldKey?: string;
  detail: string;
}

export interface NormalizedDelivery {
  /** Provider event id — the idempotency key across the provider's retries. */
  providerEventId: string | null;
  providerSubmissionId: string | null;
  providerRespondentId: string | null;
  providerFormId: string | null;
  providerFormName: string | null;
  eventType: string | null;
  /** When the provider says the submission happened. */
  submittedAt: Date | null;
  answers: NormalizedAnswer[];
  /** The observed form schema, for catalog sync and drift detection. */
  fields: NormalizedField[];
  warnings: AdapterWarning[];
}

export interface IngestAdapter {
  readonly provider: string;
  /** Throws `InvalidPayloadError` if the body is not recognisable. */
  parse(body: unknown): NormalizedDelivery;
}

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

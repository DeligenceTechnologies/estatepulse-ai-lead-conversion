export interface NormalizedAnswer {
  key: string;
  label: string;
  type: string;
  raw: unknown;
  textValues: string[];
  scalarText: string;
  optionIds?: string[];
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
  providerEventId: string | null;
  providerSubmissionId: string | null;
  providerRespondentId: string | null;
  providerFormId: string | null;
  providerFormName: string | null;
  eventType: string | null;
  submittedAt: Date | null;
  answers: NormalizedAnswer[];
  fields: NormalizedField[];
  warnings: AdapterWarning[];
}

export interface IngestAdapter {
  readonly provider: string;
  parse(body: unknown): NormalizedDelivery;
}

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

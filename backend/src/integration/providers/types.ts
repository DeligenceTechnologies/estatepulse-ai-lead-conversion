import type { DescribedField } from './tally/tally-form-schema';

export interface ProviderCredential {
  readonly apiKey: string;
}

export interface ProviderAccount {
  externalAccountId: string;
  email: string | null;
  displayName: string | null;
}

export interface ProviderForm {
  externalFormId: string;
  name: string;
  status: string | null;
  submissionCount: number | null;
  isClosed: boolean;
  externalWorkspaceId: string | null;
  updatedAt: Date | null;
}

export interface ProviderFormPage {
  items: ProviderForm[];
  nextCursor: string | null;
}

export interface ProviderWebhookRef {
  externalFormId: string;
  externalWebhookId: string;
}

export interface ProviderWebhook extends ProviderWebhookRef {
  url: string;
  isEnabled: boolean;
  externalRef: string | null;
}

export interface InstallWebhookInput {
  externalFormId: string;
  url: string;
  signingSecret: string | null;
  externalRef: string;
}

export interface UpdateWebhookPatch {
  url?: string;
  signingSecret?: string | null;
  isEnabled?: boolean;
}

export interface ProviderCapabilities {
  readonly supportsSigningSecret: boolean;
  readonly supportsWebhookList: boolean;
  readonly supportsWebhookUpdate: boolean;
  readonly supportsExternalRef: boolean;
  readonly installIsIdempotent: boolean;
  readonly signatureHeader: string | null;
  readonly credentialLabel: string;
  readonly credentialHint: string;
}

export interface FormProviderAdapter {
  readonly provider: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  verifyCredential(cred: ProviderCredential): Promise<ProviderAccount>;
  listForms(cred: ProviderCredential, cursor?: string | null): Promise<ProviderFormPage>;
  describeForm(cred: ProviderCredential, externalFormId: string): Promise<DescribedField[]>;
  listWebhooks(cred: ProviderCredential, externalFormId: string): Promise<ProviderWebhook[]>;
  installWebhook(cred: ProviderCredential, input: InstallWebhookInput): Promise<ProviderWebhook>;
  updateWebhook(
    cred: ProviderCredential,
    ref: ProviderWebhookRef,
    patch: UpdateWebhookPatch,
  ): Promise<ProviderWebhook>;
  uninstallWebhook(cred: ProviderCredential, ref: ProviderWebhookRef): Promise<void>;
}

export type ProviderErrorKind =
  | 'INVALID_CREDENTIAL'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNEXPECTED_RESPONSE';

export class ProviderApiError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    readonly operation: string,
    message: string,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMITED' || this.kind === 'PROVIDER_UNAVAILABLE';
  }

  get mayHaveExecuted(): boolean {
    return this.kind === 'PROVIDER_UNAVAILABLE' || this.kind === 'UNEXPECTED_RESPONSE';
  }
}

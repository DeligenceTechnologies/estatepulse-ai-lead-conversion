/**
 * The control-plane boundary: talking to a form provider's management API.
 *
 * Deliberately separate from `IngestAdapter` (src/modules/ingest/adapters), which
 * is the DATA plane. That one is pure, synchronous, and parses attacker-controlled
 * bytes on a latency-sensitive path. This one is async, network-bound, fallible,
 * and authenticated as our tenant. Folding them together would put a `fetch`
 * behind an interface the ingest hot path instantiates per request.
 *
 * They are joined only by the provider code.
 *
 * The shape below is checked against the two providers most likely to come next,
 * so that adding one is a new file rather than a change here:
 *
 *   Typeform  PUT /forms/{id}/webhooks/{tag}   bearer header, secret supported,
 *             the caller-chosen `tag` IS the webhook id, so install is an upsert
 *   Jotform   POST /form/{id}/webhooks         API key in the BODY, no signing
 *             at all, and the webhook id is an array index
 *
 * Hence: no assumption that install is a POST, that the credential rides in a
 * header, that a webhook can be addressed without its form, or that signing
 * exists. Pagination is an opaque cursor because page numbers, offsets and
 * cursors all have to serialize into it.
 */

import type { DescribedField } from './tally/tally-form-schema';

export interface ProviderCredential {
  /** Plaintext, held only for the duration of one call. Never log or persist. */
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
  /** Provider-native ('PUBLISHED' | 'DRAFT' | …). Displayed, never switched on. */
  status: string | null;
  submissionCount: number | null;
  isClosed: boolean;
  externalWorkspaceId: string | null;
  updatedAt: Date | null;
}

export interface ProviderFormPage {
  items: ProviderForm[];
  /** Opaque. Null when there is no further page. */
  nextCursor: string | null;
}

/**
 * Identifies one installed webhook.
 *
 * Carries the form id because Typeform (`DELETE /forms/{id}/webhooks/{tag}`) and
 * Jotform (`DELETE /form/{id}/webhooks/{n}`) cannot address a webhook without it.
 * Tally ignores it.
 */
export interface ProviderWebhookRef {
  externalFormId: string;
  externalWebhookId: string;
}

export interface ProviderWebhook extends ProviderWebhookRef {
  url: string;
  isEnabled: boolean;
  /** Echo of `externalRef` where the provider round-trips it, else null. */
  externalRef: string | null;
}

export interface InstallWebhookInput {
  externalFormId: string;
  url: string;
  /** Null when `capabilities.supportsSigningSecret` is false. */
  signingSecret: string | null;
  /**
   * Our lead_sources.id. Tally -> `externalSubscriber`; Typeform -> the `tag`
   * path segment; Jotform -> dropped, which is why it is a capability.
   *
   * This is what makes reconciliation possible: "is this webhook ours?" is
   * answerable without trusting our own stored id.
   */
  externalRef: string;
}

export interface UpdateWebhookPatch {
  url?: string;
  /** `null` clears the secret; `undefined` leaves it alone. */
  signingSecret?: string | null;
  isEnabled?: boolean;
}

export interface ProviderCapabilities {
  /** False => require_signature must be false, and the UI must say why. */
  readonly supportsSigningSecret: boolean;
  /** False => no reconciliation; we can only trust our stored webhook id. */
  readonly supportsWebhookList: boolean;
  readonly supportsWebhookUpdate: boolean;
  /** False => reconciliation must fall back to matching on URL. */
  readonly supportsExternalRef: boolean;
  /** True => install is an upsert, so a double-click is free. */
  readonly installIsIdempotent: boolean;
  /** Header the ingest side reads. Null when the provider does not sign. */
  readonly signatureHeader: string | null;
  /** UI copy, kept here so the frontend carries no provider-specific strings. */
  readonly credentialLabel: string;
  readonly credentialHint: string;
}

export interface FormProviderAdapter {
  readonly provider: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  /** Validates the credential and labels the account it belongs to. */
  verifyCredential(cred: ProviderCredential): Promise<ProviderAccount>;

  listForms(cred: ProviderCredential, cursor?: string | null): Promise<ProviderFormPage>;

  /**
   * The form's field schema, for mapping it before anyone submits it.
   *
   * How many API calls this costs is the adapter's business — Tally needs two,
   * because options are not in its questions endpoint.
   */
  describeForm(cred: ProviderCredential, externalFormId: string): Promise<DescribedField[]>;

  /** Every webhook on one form. Client-side filtering is the adapter's problem. */
  listWebhooks(cred: ProviderCredential, externalFormId: string): Promise<ProviderWebhook[]>;

  installWebhook(cred: ProviderCredential, input: InstallWebhookInput): Promise<ProviderWebhook>;

  updateWebhook(
    cred: ProviderCredential,
    ref: ProviderWebhookRef,
    patch: UpdateWebhookPatch,
  ): Promise<ProviderWebhook>;

  /** MUST resolve, not throw, when the webhook is already gone. */
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

  /** Only these two can be helped by trying again. */
  get retryable(): boolean {
    return this.kind === 'RATE_LIMITED' || this.kind === 'PROVIDER_UNAVAILABLE';
  }

  /**
   * "Definitely did not happen" vs "might have happened".
   *
   * This is the distinction that decides whether a failed install is rolled back
   * or reconciled. A 401/403/404/400/429 never created a webhook, so deleting our
   * provisional row is safe. A 5xx or timeout might have created one, and
   * deleting the row then would leave a live webhook pointing at a dead token —
   * which means Tally retries into 404s and eventually emails the customer that
   * our integration is broken.
   */
  get mayHaveExecuted(): boolean {
    return this.kind === 'PROVIDER_UNAVAILABLE' || this.kind === 'UNEXPECTED_RESPONSE';
  }
}

/**
 * Typeform's management API, behind the provider-agnostic interface.
 *
 * Where it differs from Tally, and why the interface already allowed for it:
 *
 *   - A webhook is addressed by (form, tag), never by an id of its own:
 *     `PUT/DELETE /forms/{id}/webhooks/{tag}`. So `externalWebhookId` IS the tag,
 *     and the tag is our lead_sources.id, which is what makes "is this webhook
 *     ours?" answerable from the provider's own list.
 *   - Install is a PUT, so it is an upsert: a double-click or a reinstall lands
 *     on the same webhook rather than a duplicate.
 *   - The webhook list is per form, so no account-wide paging and filtering.
 */

import { Injectable } from '@nestjs/common';
import { ProviderApiError } from '../types';
import type {
  DescribedField,
  FormProviderAdapter,
  InstallWebhookInput,
  ProviderAccount,
  ProviderCapabilities,
  ProviderCredential,
  ProviderForm,
  ProviderFormPage,
  ProviderWebhook,
  ProviderWebhookRef,
  UpdateWebhookPatch,
} from '../types';
import { TypeformClient } from './typeform.client';
import { describeTypeformForm, type TypeformField } from './typeform-form-schema';

/** Typeform's maximum. */
const FORMS_PAGE_SIZE = 200;

interface TypeformFormSummary {
  id: string;
  title: string;
  last_updated_at?: string | null;
  settings?: { is_public?: boolean | null } | null;
}

interface TypeformWebhook {
  id?: string;
  form_id: string;
  tag: string;
  url: string;
  enabled?: boolean;
}

@Injectable()
export class TypeformProviderAdapter implements FormProviderAdapter {
  readonly provider = 'TYPEFORM';
  readonly displayName = 'Typeform';

  readonly capabilities: ProviderCapabilities = {
    supportsSigningSecret: true,
    supportsWebhookList: true,
    supportsWebhookUpdate: true,
    supportsExternalRef: true,
    // PUT /forms/{id}/webhooks/{tag} creates or replaces.
    installIsIdempotent: true,
    signatureHeader: 'typeform-signature',
    credentialLabel: 'Typeform personal access token',
    credentialHint:
      'Typeform → your avatar → Settings → Personal tokens → Generate a new token, with the ' +
      'accounts:read, forms:read, webhooks:read and webhooks:write scopes. Typeform shows it once.',
  };

  constructor(private readonly http: TypeformClient) {}

  async verifyCredential(cred: ProviderCredential): Promise<ProviderAccount> {
    const me = await this.http.get<{ user_id?: string; email?: string; alias?: string }>(
      cred.apiKey,
      '/me',
      'verifyCredential',
    );
    return {
      externalAccountId: me?.user_id ?? 'unknown',
      email: me?.email ?? null,
      displayName: me?.alias ?? null,
    };
  }

  async listForms(cred: ProviderCredential, cursor?: string | null): Promise<ProviderFormPage> {
    const page = Math.max(1, Number(cursor ?? 1) || 1);
    const res = await this.http.get<{ items?: TypeformFormSummary[]; page_count?: number }>(
      cred.apiKey,
      `/forms?page=${page}&page_size=${FORMS_PAGE_SIZE}`,
      'listForms',
    );

    const items: ProviderForm[] = (res?.items ?? []).map((f) => ({
      externalFormId: f.id,
      name: f.title,
      status: null,
      // Only `GET /forms/{id}/responses` knows the count; one call per form is
      // too much for a picker.
      submissionCount: null,
      // "Close form" in Typeform's UI is what flips is_public off.
      isClosed: f.settings?.is_public === false,
      externalWorkspaceId: null,
      updatedAt: f.last_updated_at ? new Date(f.last_updated_at) : null,
    }));

    return { items, nextCursor: page < (res?.page_count ?? 1) ? String(page + 1) : null };
  }

  async describeForm(cred: ProviderCredential, externalFormId: string): Promise<DescribedField[]> {
    const form = await this.http.get<{ fields?: TypeformField[] }>(
      cred.apiKey,
      `/forms/${encodeURIComponent(externalFormId)}`,
      'describeForm',
    );
    return describeTypeformForm(form?.fields);
  }

  async listWebhooks(cred: ProviderCredential, externalFormId: string): Promise<ProviderWebhook[]> {
    const res = await this.http.get<{ items?: TypeformWebhook[] }>(
      cred.apiKey,
      `/forms/${encodeURIComponent(externalFormId)}/webhooks`,
      'listWebhooks',
    );
    return (res?.items ?? []).map((w) => this.toWebhook({ ...w, form_id: w.form_id ?? externalFormId }));
  }

  async installWebhook(cred: ProviderCredential, input: InstallWebhookInput): Promise<ProviderWebhook> {
    const created = await this.http.put<TypeformWebhook>(
      cred.apiKey,
      this.webhookPath(input.externalFormId, input.externalRef),
      {
        url: input.url,
        enabled: true,
        verify_ssl: true,
        ...(input.signingSecret ? { secret: input.signingSecret } : {}),
      },
      'installWebhook',
    );

    if (!created?.tag) {
      throw new ProviderApiError(
        'UNEXPECTED_RESPONSE',
        'TYPEFORM',
        'installWebhook',
        'Typeform accepted the webhook but returned no tag, so we cannot manage it later.',
      );
    }

    return this.toWebhook({ ...created, form_id: created.form_id ?? input.externalFormId });
  }

  async updateWebhook(
    cred: ProviderCredential,
    ref: ProviderWebhookRef,
    patch: UpdateWebhookPatch,
  ): Promise<ProviderWebhook> {
    // PUT replaces, and `url` and `enabled` are required, so a partial patch
    // has to be merged over what is there now.
    const current =
      patch.url === undefined || patch.isEnabled === undefined
        ? await this.http.get<TypeformWebhook>(
            cred.apiKey,
            this.webhookPath(ref.externalFormId, ref.externalWebhookId),
            'updateWebhook.read',
          )
        : null;

    const updated = await this.http.put<TypeformWebhook>(
      cred.apiKey,
      this.webhookPath(ref.externalFormId, ref.externalWebhookId),
      {
        url: patch.url ?? current?.url,
        enabled: patch.isEnabled ?? current?.enabled ?? true,
        verify_ssl: true,
        // `null` clears the secret; `undefined` leaves whatever Typeform holds.
        ...(patch.signingSecret ? { secret: patch.signingSecret } : {}),
      },
      'updateWebhook',
    );

    return this.toWebhook({
      tag: ref.externalWebhookId,
      form_id: ref.externalFormId,
      url: updated?.url ?? patch.url ?? current?.url ?? '',
      enabled: updated?.enabled ?? patch.isEnabled ?? true,
    });
  }

  async uninstallWebhook(cred: ProviderCredential, ref: ProviderWebhookRef): Promise<void> {
    // `delete` swallows 404 — already gone is the outcome we wanted.
    await this.http.delete(cred.apiKey, this.webhookPath(ref.externalFormId, ref.externalWebhookId), 'uninstallWebhook');
  }

  private webhookPath(formId: string, tag: string): string {
    return `/forms/${encodeURIComponent(formId)}/webhooks/${encodeURIComponent(tag)}`;
  }

  /** Typeform echoes `secret` on some responses. Dropped here, deliberately. */
  private toWebhook(w: TypeformWebhook): ProviderWebhook {
    return {
      externalFormId: w.form_id,
      externalWebhookId: w.tag,
      url: w.url,
      isEnabled: w.enabled ?? true,
      externalRef: w.tag,
    };
  }
}

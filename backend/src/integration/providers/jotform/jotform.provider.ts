/**
 * Jotform's management API, behind the provider-agnostic interface.
 *
 * Where it differs from Tally and Typeform:
 *
 *   - A form's webhooks are a plain list of URLs, addressed by their position:
 *     `DELETE /form/{id}/webhooks/{index}`. Deleting one shifts every later
 *     index down, so a stored index goes stale. The URL is the only stable
 *     handle, so `externalWebhookId` IS the URL, and every delete looks the
 *     index up again just before it runs.
 *   - No signing secret, no tag or subscriber field, no update. The token in
 *     the URL is the whole credential, as on the generic webhook route.
 *   - Install appends, so it is made idempotent here by checking the list first.
 */

import { Injectable } from '@nestjs/common';
import type {
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
import type { DescribedField } from '../tally/tally-form-schema';
import { JotformClient } from './jotform.client';
import { describeJotformForm, type JotformQuestion } from './jotform-form-schema';

const FORMS_PAGE_SIZE = 100;

interface JotformUser {
  username?: string;
  name?: string;
  email?: string;
}

interface JotformFormSummary {
  id: string;
  title?: string;
  status?: string;
  count?: string | number;
  updated_at?: string | null;
  created_at?: string | null;
}

/** `{ "0": "https://…", "1": "https://…" }`, or an empty array when there are none. */
type JotformWebhookMap = Record<string, string> | string[] | null | undefined;

@Injectable()
export class JotformProviderAdapter implements FormProviderAdapter {
  readonly provider = 'JOTFORM';
  readonly displayName = 'Jotform';

  readonly capabilities: ProviderCapabilities = {
    supportsSigningSecret: false,
    supportsWebhookList: true,
    supportsWebhookUpdate: false,
    supportsExternalRef: false,
    // installWebhook checks the list before adding, so a repeat is harmless.
    installIsIdempotent: true,
    signatureHeader: null,
    credentialLabel: 'Jotform API key',
    credentialHint: 'Jotform → My Account → API → Create New Key, with Full Access permission.',
  };

  constructor(private readonly http: JotformClient) {}

  async verifyCredential(cred: ProviderCredential): Promise<ProviderAccount> {
    const me = await this.http.get<JotformUser>(cred.apiKey, '/user', 'verifyCredential');
    return {
      externalAccountId: me?.username ?? 'unknown',
      email: me?.email ?? null,
      displayName: me?.name || me?.username || null,
    };
  }

  async listForms(cred: ProviderCredential, cursor?: string | null): Promise<ProviderFormPage> {
    const offset = Math.max(0, Number(cursor ?? 0) || 0);
    const res = await this.http.get<JotformFormSummary[]>(
      cred.apiKey,
      `/user/forms?offset=${offset}&limit=${FORMS_PAGE_SIZE}&orderby=updated_at`,
      'listForms',
    );
    const page = Array.isArray(res) ? res : [];

    const items: ProviderForm[] = page
      .filter((f) => f.id && f.status !== 'DELETED')
      .map((f) => ({
        externalFormId: String(f.id),
        name: f.title?.trim() || 'Untitled form',
        status: f.status ?? null,
        submissionCount: f.count === undefined || f.count === null ? null : Number(f.count) || 0,
        isClosed: f.status !== undefined && f.status !== 'ENABLED',
        externalWorkspaceId: null,
        updatedAt: parseJotformDate(f.updated_at ?? f.created_at),
      }));

    // The page is judged full before DELETED forms are dropped, so paging does not stop early.
    return { items, nextCursor: page.length === FORMS_PAGE_SIZE ? String(offset + FORMS_PAGE_SIZE) : null };
  }

  async describeForm(cred: ProviderCredential, externalFormId: string): Promise<DescribedField[]> {
    const questions = await this.http.get<Record<string, JotformQuestion>>(
      cred.apiKey,
      `/form/${encodeURIComponent(externalFormId)}/questions`,
      'describeForm',
    );
    return describeJotformForm(questions);
  }

  async listWebhooks(cred: ProviderCredential, externalFormId: string): Promise<ProviderWebhook[]> {
    const urls = await this.webhookUrls(cred, externalFormId, 'listWebhooks');
    return urls.map(({ url }) => this.toWebhook(externalFormId, url));
  }

  async installWebhook(cred: ProviderCredential, input: InstallWebhookInput): Promise<ProviderWebhook> {
    const existing = await this.webhookUrls(cred, input.externalFormId, 'installWebhook.read');
    if (!existing.some((w) => w.url === input.url)) {
      await this.http.post<JotformWebhookMap>(
        cred.apiKey,
        `/form/${encodeURIComponent(input.externalFormId)}/webhooks`,
        { webhookURL: input.url },
        'installWebhook',
      );
    }
    return this.toWebhook(input.externalFormId, input.url);
  }

  /**
   * Jotform cannot edit a webhook, so this replaces it. Only reached if a
   * caller ignores `supportsWebhookUpdate: false`. Disabling is a removal.
   */
  async updateWebhook(
    cred: ProviderCredential,
    ref: ProviderWebhookRef,
    patch: UpdateWebhookPatch,
  ): Promise<ProviderWebhook> {
    const url = patch.url ?? ref.externalWebhookId;
    if (patch.isEnabled === false) {
      await this.uninstallWebhook(cred, ref);
      return { ...this.toWebhook(ref.externalFormId, url), isEnabled: false };
    }
    if (url === ref.externalWebhookId) return this.toWebhook(ref.externalFormId, url);
    const installed = await this.installWebhook(cred, {
      externalFormId: ref.externalFormId,
      url,
      signingSecret: null,
      externalRef: '',
    });
    await this.uninstallWebhook(cred, ref);
    return installed;
  }

  async uninstallWebhook(cred: ProviderCredential, ref: ProviderWebhookRef): Promise<void> {
    const current = await this.webhookUrls(cred, ref.externalFormId, 'uninstallWebhook.read');
    // Every copy of our URL, highest index first, so deleting one does not move the next.
    const indexes = current
      .filter((w) => w.url === ref.externalWebhookId)
      .map((w) => w.index)
      .sort((a, b) => b - a);
    for (const index of indexes) {
      // `delete` swallows 404 — already gone is the outcome we wanted.
      await this.http.delete(
        cred.apiKey,
        `/form/${encodeURIComponent(ref.externalFormId)}/webhooks/${index}`,
        'uninstallWebhook',
      );
    }
  }

  private async webhookUrls(
    cred: ProviderCredential,
    externalFormId: string,
    operation: string,
  ): Promise<{ index: number; url: string }[]> {
    const map = await this.http.get<JotformWebhookMap>(
      cred.apiKey,
      `/form/${encodeURIComponent(externalFormId)}/webhooks`,
      operation,
    );
    return Object.entries(map ?? {})
      .filter(([, url]) => typeof url === 'string' && url.length > 0)
      .map(([index, url]) => ({ index: Number(index), url: url as string }))
      .filter((w) => Number.isInteger(w.index));
  }

  private toWebhook(externalFormId: string, url: string): ProviderWebhook {
    return { externalFormId, externalWebhookId: url, url, isEnabled: true, externalRef: null };
  }
}

/** Jotform writes dates as "2026-11-25 10:04:13" (US Eastern); close enough for sorting a picker. */
function parseJotformDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

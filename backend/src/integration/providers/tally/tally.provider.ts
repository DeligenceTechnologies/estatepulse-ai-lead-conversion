import { Injectable } from '@nestjs/common';
import { ProviderApiError } from '../types';
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
import { TallyClient } from './tally.client';
import { describeTallyForm, type DescribedField, type TallyBlock, type TallyQuestion } from './tally-form-schema';

const FORMS_PAGE_SIZE = 50;
const WEBHOOKS_PAGE_SIZE = 100;

const MAX_WEBHOOK_PAGES = 10;

interface TallyFormSummary {
  id: string;
  name: string;
  status?: string | null;
  numberOfSubmissions?: number | null;
  isClosed?: boolean;
  workspaceId?: string | null;
  updatedAt?: string | null;
}

interface TallyWebhook {
  id: string;
  formId: string;
  url: string;
  isEnabled?: boolean;
  externalSubscriber?: string | null;
}

@Injectable()
export class TallyProviderAdapter implements FormProviderAdapter {
  readonly provider = 'TALLY';
  readonly displayName = 'Tally';

  readonly capabilities: ProviderCapabilities = {
    supportsSigningSecret: true,
    supportsWebhookList: true,
    supportsWebhookUpdate: true,
    supportsExternalRef: true,
    installIsIdempotent: false,
    signatureHeader: 'tally-signature',
    credentialLabel: 'Tally API key',
    credentialHint: 'Tally → Settings → API keys → Create API key. Tally shows it once.',
  };

  constructor(private readonly http: TallyClient) {}

  async verifyCredential(cred: ProviderCredential): Promise<ProviderAccount> {
    const me = await this.http.get<{ id?: string; email?: string; name?: string; fullName?: string }>(
      cred.apiKey,
      '/users/me',
      'verifyCredential',
    );
    return {
      externalAccountId: me?.id ?? 'unknown',
      email: me?.email ?? null,
      displayName: me?.fullName ?? me?.name ?? null,
    };
  }

  async listForms(cred: ProviderCredential, cursor?: string | null): Promise<ProviderFormPage> {
    const page = Math.max(1, Number(cursor ?? 1) || 1);
    const res = await this.http.get<{ items?: TallyFormSummary[]; hasMore?: boolean }>(
      cred.apiKey,
      `/forms?page=${page}&limit=${FORMS_PAGE_SIZE}`,
      'listForms',
    );

    const items: ProviderForm[] = (res?.items ?? []).map((f) => ({
      externalFormId: f.id,
      name: f.name,
      status: f.status ?? null,
      submissionCount: f.numberOfSubmissions ?? null,
      isClosed: Boolean(f.isClosed),
      externalWorkspaceId: f.workspaceId ?? null,
      updatedAt: f.updatedAt ? new Date(f.updatedAt) : null,
    }));

    return { items, nextCursor: res?.hasMore ? String(page + 1) : null };
  }

  async describeForm(cred: ProviderCredential, externalFormId: string): Promise<DescribedField[]> {
    const [questionsRes, formRes] = await Promise.all([
      this.http.get<{ questions?: TallyQuestion[] }>(
        cred.apiKey,
        `/forms/${encodeURIComponent(externalFormId)}/questions`,
        'describeForm.questions',
      ),
      this.http.get<{ blocks?: TallyBlock[] }>(
        cred.apiKey,
        `/forms/${encodeURIComponent(externalFormId)}`,
        'describeForm.blocks',
      ),
    ]);

    return describeTallyForm(questionsRes?.questions ?? [], formRes?.blocks ?? []);
  }

  async listWebhooks(cred: ProviderCredential, externalFormId: string): Promise<ProviderWebhook[]> {
    const out: ProviderWebhook[] = [];

    for (let page = 1; page <= MAX_WEBHOOK_PAGES; page++) {
      const res = await this.http.get<{ webhooks?: TallyWebhook[]; hasMore?: boolean }>(
        cred.apiKey,
        `/webhooks?page=${page}&limit=${WEBHOOKS_PAGE_SIZE}`,
        'listWebhooks',
      );

      for (const w of res?.webhooks ?? []) {
        if (w.formId === externalFormId) out.push(this.toWebhook(w));
      }
      if (!res?.hasMore) break;
    }

    return out;
  }

  async installWebhook(cred: ProviderCredential, input: InstallWebhookInput): Promise<ProviderWebhook> {
    const created = await this.http.post<TallyWebhook>(
      cred.apiKey,
      '/webhooks',
      {
        formId: input.externalFormId,
        url: input.url,
        eventTypes: ['FORM_RESPONSE'],
        ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
        externalSubscriber: input.externalRef,
      },
      'installWebhook',
    );

    if (!created?.id) {
      throw new ProviderApiError(
        'UNEXPECTED_RESPONSE',
        'TALLY',
        'installWebhook',
        'Tally accepted the webhook but returned no id, so we cannot manage it later.',
      );
    }

    return this.toWebhook({ ...created, formId: created.formId ?? input.externalFormId });
  }

  async updateWebhook(
    cred: ProviderCredential,
    ref: ProviderWebhookRef,
    patch: UpdateWebhookPatch,
  ): Promise<ProviderWebhook> {
    const updated = await this.http.patch<TallyWebhook>(
      cred.apiKey,
      `/webhooks/${encodeURIComponent(ref.externalWebhookId)}`,
      {
        formId: ref.externalFormId,
        eventTypes: ['FORM_RESPONSE'],
        ...(patch.url === undefined ? {} : { url: patch.url }),
        ...(patch.signingSecret === undefined ? {} : { signingSecret: patch.signingSecret }),
        ...(patch.isEnabled === undefined ? {} : { isEnabled: patch.isEnabled }),
      },
      'updateWebhook',
    );

    return this.toWebhook({
      id: ref.externalWebhookId,
      formId: ref.externalFormId,
      url: patch.url ?? updated?.url ?? '',
      isEnabled: updated?.isEnabled ?? patch.isEnabled ?? true,
      externalSubscriber: updated?.externalSubscriber ?? null,
    });
  }

  async uninstallWebhook(cred: ProviderCredential, ref: ProviderWebhookRef): Promise<void> {
    await this.http.delete(
      cred.apiKey,
      `/webhooks/${encodeURIComponent(ref.externalWebhookId)}`,
      'uninstallWebhook',
    );
  }

  private toWebhook(w: TallyWebhook): ProviderWebhook {
    return {
      externalFormId: w.formId,
      externalWebhookId: w.id,
      url: w.url,
      isEnabled: w.isEnabled ?? true,
      externalRef: w.externalSubscriber ?? null,
    };
  }
}

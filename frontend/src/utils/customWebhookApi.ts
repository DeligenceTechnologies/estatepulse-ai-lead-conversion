import type { LeadSourceConfig } from '../api/client';
import { ApiError, apiFetch } from '../lib/api';

/**
 * Webhooks: one URL any app or form can post a lead to. A form provider we
 * understand (Tally) is parsed as a form; anything else is mapped by the owner
 * from the first payload. These routes exist only where the server has
 * CUSTOM_WEBHOOK_ENABLED=1; elsewhere every one answers 404.
 */

const BASE = '/v1/custom-webhooks';

export const CUSTOM_PROVIDER = 'CUSTOM';
export const isCustomSource = (s: { provider?: string | null }): boolean => (s.provider ?? '').toUpperCase() === CUSTOM_PROVIDER;

export type CustomAuth =
  | { mode: 'none' }
  | { mode: 'header_secret'; headerName: string }
  | { mode: 'hmac'; headerName: string; algorithm: 'sha256' | 'sha1'; encoding: 'hex' | 'base64'; prefix?: string }
  | { mode: 'basic'; username: string };
export type AuthMode = CustomAuth['mode'];

export type CustomTarget =
  | 'full_name'
  | 'first_name'
  | 'last_name'
  | 'phone'
  | 'email'
  | 'location'
  | 'budget_range'
  | 'min_budget'
  | 'max_budget'
  | 'bedrooms'
  | 'motivation'
  | 'consent_status'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'timeline'
  | 'buying_intent'
  | 'financing_status'
  | '__custom__';

/** The option map a form's choice question carries; the only transform the owner may send. */
export interface EnumMapTransform {
  kind: 'enum_map';
  byOptionText: Record<string, string>;
  fallback?: string | null;
}

export interface MappingField {
  path: string;
  target: CustomTarget;
  /** The extra field's name; only with target __custom__. */
  customName?: string;
  /** Required for timeline / buying_intent / financing_status; comes from the suggestion. */
  transform?: EnumMapTransform;
}

export interface CustomWebhook extends LeadSourceConfig {
  custom: {
    auth: CustomAuth;
    deliveryIdHeader: string | null;
    /** Deliveries dropped at the held cap while the source was unmapped. */
    dropped: number;
    /** Switched on: deliveries become leads. Off: they are held. */
    activated: boolean;
    /** Deliveries waiting for the mapping. */
    held: number;
    mappingConfigured: boolean;
    mappingVersion: number;
    fields: MappingField[];
  };
}

/** Only create and an auth change return the secret, and only once. */
export interface CustomWebhookCreated extends CustomWebhook {
  secret: string | null;
}

export interface SamplePath {
  /** The source field key: a JSON path, or a form's question key. */
  path: string;
  /** What to show: the question text for a form, the path itself otherwise. */
  label: string;
  value: string;
  type: string;
}

export interface CustomWebhookSample extends CustomWebhook {
  delivery: { id: string; receivedAt: string; held: boolean } | null;
  /** The form provider whose shape the last payload had ('TALLY'), or null for plain JSON. */
  format: string | null;
  paths: SamplePath[];
  truncated: boolean;
  suggested: MappingField[];
}

export interface LeadPreview {
  wouldCreate: boolean;
  status: 'new' | 'invalid' | null;
  values: Record<string, string | number | boolean | null>;
  customFields: Record<string, string>;
  warnings: string[];
  reviewReasons: string[];
}

export interface TestResult {
  delivery: { id: string; receivedAt: string };
  preview: LeadPreview;
}

export const isCustomWebhookDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

export const customWebhookEnabled = (): Promise<boolean> =>
  apiFetch<{ enabled: boolean }>(`${BASE}/config`, { auth: true }).then(
    () => true,
    (e) => !isCustomWebhookDisabled(e),
  );

export const createCustomWebhook = (body: { name: string; auth: CustomAuth; deliveryIdHeader?: string }): Promise<CustomWebhookCreated> =>
  apiFetch<CustomWebhookCreated>(BASE, { method: 'POST', body, auth: true });

export const getCustomWebhook = (id: string): Promise<CustomWebhook> => apiFetch<CustomWebhook>(`${BASE}/${id}`, { auth: true });

export const customWebhookSample = (id: string): Promise<CustomWebhookSample> =>
  apiFetch<CustomWebhookSample>(`${BASE}/${id}/sample`, { auth: true });

export const saveCustomWebhookMapping = (id: string, fields: MappingField[]): Promise<CustomWebhook> =>
  apiFetch<CustomWebhook>(`${BASE}/${id}/mapping`, { method: 'PUT', body: { fields }, auth: true });

/** A dry run over the last payload: the draft when `fields` is given, the saved mapping otherwise. */
export const testCustomWebhook = (id: string, fields?: MappingField[]): Promise<TestResult> =>
  apiFetch<TestResult>(`${BASE}/${id}/test`, { method: 'POST', body: fields ? { fields } : {}, auth: true });

export const activateCustomWebhook = (id: string): Promise<CustomWebhook & { released: number }> =>
  apiFetch<CustomWebhook & { released: number }>(`${BASE}/${id}/activate`, { method: 'POST', body: {}, auth: true });

export const updateCustomWebhookAuth = (id: string, body: { auth: CustomAuth; deliveryIdHeader?: string | null }): Promise<CustomWebhookCreated> =>
  apiFetch<CustomWebhookCreated>(`${BASE}/${id}/auth`, { method: 'PATCH', body, auth: true });

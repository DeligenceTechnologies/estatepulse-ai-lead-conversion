// EstatePulse AI-agent (Telnyx) API — goes through the shared apiFetch (relative /api,
// Bearer token, org resolved from the JWT server-side). No provider name leaks to the browser.
import { apiFetch } from '../lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AssistantTool {
  type: 'webhook' | 'transfer' | 'hangup' | string;
  webhook?: any;
  transfer?: any;
  hangup?: any;
  [k: string]: any;
}

export interface AssistantConfig {
  id: string;
  name: string;
  model: string;
  instructions: string;
  greeting: string;
  voice: string;
  voice_speed: number;
  background_audio: string;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  expressive_mode: boolean;
  language_boost: string;
  stt_model: string;
  stt_language: string;
  eot_threshold: number;
  eot_timeout_ms: number;
  allow_interruptions: boolean;
  record_calls: boolean;
  max_call_secs: number;
  user_idle_timeout_secs: number;
  post_call_processing: boolean;
  dynamic_variables: Record<string, string>;
  tools: AssistantTool[];
}

export type AssistantPatch = Partial<Omit<AssistantConfig, 'id' | 'name'>>;

export interface TelnyxStatus {
  connected: boolean;
  hasAssistant: boolean;
  hasIntegration?: boolean;
  status?: string;
  apiKeyMasked: string;
  connectionId: string;
  messagingProfileId: string;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

export interface OrgIntegration {
  id: string;
  provider: string;
  type: string;
  status: string;
  externalAccountId: string | null;
  metadata: Record<string, any>;
  connectedAt: string | null;
  updatedAt: string | null;
}
export const getIntegrations = () =>
  apiFetch<{ integrations: OrgIntegration[] }>('/integrations', { auth: true }).then((d) => d.integrations);
export const reconnectTelnyx = () =>
  apiFetch<TelnyxStatus>('/telnyx/reconnect', { method: 'POST', auth: true });

export interface TelnyxCredentials {
  apiKey?: string;
  publicKey?: string;
  connectionId?: string;
  messagingProfileId?: string;
  fromNumber?: string;
}

export interface AvailableNumber {
  phone_number: string;
  upfront_cost?: string;
  monthly_cost?: string;
  currency?: string;
  region?: string;
  features: string[];
}
export interface OwnedNumber {
  id: string;
  phone_number: string;
  connection_id?: string;
  messaging_profile_id?: string;
}
export interface AssistantSummary {
  id: string;
  name: string;
  model: string;
}

// ---- Connection ----
export const getTelnyxStatus = () => apiFetch<TelnyxStatus>('/telnyx/status', { auth: true });
export const saveTelnyxCredentials = (creds: TelnyxCredentials) =>
  apiFetch<TelnyxStatus>('/telnyx/credentials', { method: 'PUT', body: creds, auth: true });
export const disconnectTelnyx = () =>
  apiFetch<TelnyxStatus>('/telnyx/credentials', { method: 'DELETE', auth: true });

// ---- Assistant ----
export const createAssistant = (name?: string) =>
  apiFetch<{ assistant: AssistantConfig; status: TelnyxStatus }>('/telnyx/assistant/create', {
    method: 'POST',
    body: name && name.trim() ? { name: name.trim() } : {},
    auth: true,
  });
export const attachAssistant = (assistantId: string) =>
  apiFetch<{ assistant: AssistantConfig; status: TelnyxStatus }>('/telnyx/assistant/attach', {
    method: 'POST',
    body: { assistantId },
    auth: true,
  });
export const listAssistants = () =>
  apiFetch<{ assistants: AssistantSummary[] }>('/telnyx/assistants', { auth: true }).then((d) => d.assistants);
export const getAssistant = () =>
  apiFetch<{ assistant: AssistantConfig }>('/assistant', { auth: true }).then((d) => d.assistant);
export const updateAssistant = (patch: AssistantPatch) =>
  apiFetch<{ assistant: AssistantConfig }>('/assistant', { method: 'PATCH', body: patch, auth: true }).then((d) => d.assistant);
export const listModels = () =>
  apiFetch<{ models: string[] }>('/assistant/models', { auth: true }).then((d) => d.models).catch(() => [] as string[]);

// ---- Numbers ----
export function searchNumbers(params: { country?: string; area?: string; features?: string; type?: string; limit?: number }) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') q.set(k, String(v)); });
  return apiFetch<{ numbers: AvailableNumber[] }>(`/telnyx/numbers/available?${q.toString()}`, { auth: true }).then((d) => d.numbers);
}
export const listOwnedNumbers = () =>
  apiFetch<{ numbers: OwnedNumber[] }>('/telnyx/numbers/owned', { auth: true }).then((d) => d.numbers);
export const buyNumber = (phone_number: string) =>
  apiFetch<any>('/telnyx/numbers/buy', { method: 'POST', body: { phone_number }, auth: true });
export const assignNumber = (phone_number: string) =>
  apiFetch<{ status: TelnyxStatus }>('/telnyx/numbers/assign', { method: 'POST', body: { phone_number }, auth: true });
export const unassignNumber = (phone_number: string) =>
  apiFetch<{ status: TelnyxStatus }>('/telnyx/numbers/unassign', { method: 'POST', body: { phone_number }, auth: true });

export const BACKGROUND_AUDIO_OPTIONS = ['silence', 'office', 'coffee_shop'];
export const LANGUAGE_BOOST_OPTIONS = ['English', 'Spanish', 'French', 'German', 'None'];

// ---- Tools / Workflows helpers ----
export function toolLabel(t: AssistantTool): string {
  if (t.type === 'transfer') {
    const to = t.transfer?.targets?.[0]?.to || t.transfer?.to || '';
    return `Transfer${to ? ` → ${to}` : ''}`;
  }
  if (t.type === 'webhook') return `Webhook: ${t.webhook?.name || t.webhook?.url || 'unnamed'}`;
  if (t.type === 'hangup') return 'Hang up';
  return t.type;
}

// ---- Tone: stored as a managed directive line on the prompt ----
export const TONE_DIRECTIVE: Record<string, string> = {
  Conversational: 'natural, warm and human-like',
  Professional: 'professional, polished and consultative',
  Friendly: 'friendly, casual and enthusiastic',
  Concise: 'concise, fast and direct, with a low word count',
};
const TONE_RE = /\n*Tone directive:.*$/m;
export function stripTone(instructions: string): string {
  return (instructions || '').replace(TONE_RE, '').trim();
}
export function extractTone(instructions: string): string | null {
  const m = (instructions || '').match(/Tone directive:\s*(\w+)/);
  return m && TONE_DIRECTIVE[m[1]] ? m[1] : null;
}
export function applyTone(prompt: string, tone: string): string {
  const base = stripTone(prompt);
  const desc = TONE_DIRECTIVE[tone];
  return desc ? `${base}\n\nTone directive: ${tone} — speak in a ${desc} manner.` : base;
}

// ---- Lead ingestion sources (mint/list/toggle webhook tokens) ----
export interface IngestSource {
  id: string;
  label: string;
  code: string;
  prefix: string | null;
  active: boolean;
  sourceType: string;
  hasToken: boolean;
  createdAt: string;
}
export interface NewIngestSource {
  id: string;
  label: string;
  token: string; // shown ONCE
  prefix: string;
  webhookUrl: string;
  tallyUrl: string;
}
export const listIngestSources = () =>
  apiFetch<{ sources: IngestSource[] }>('/ingest/sources', { auth: true }).then((r) => r.sources);
export const createIngestSource = (label: string) =>
  apiFetch<NewIngestSource>('/ingest/sources', { method: 'POST', body: { label }, auth: true });
export const setIngestSourceActive = (id: string, active: boolean) =>
  apiFetch<{ ok: boolean; active: boolean }>(`/ingest/sources/${id}`, { method: 'PATCH', body: { active }, auth: true });

// ---- Tally connection (the ingestion routes, /api/v1/*) --------------------
//
// These used to go through a /api/tally/* proxy that swapped the session token
// for a per-org API key, because the ingestion service was a second process.
// It is the same process now, and its guard accepts the session token directly,
// so these call the real endpoints.
export interface TallyConnection {
  id: string;
  provider: string;
  label?: string | null;
  accountEmail?: string | null;
  displayName?: string | null;
  verificationState?: string | null;
  status?: string | null;
}
export interface TallyForm {
  externalFormId: string;
  name: string;
  status?: string | null;
  submissionCount?: number | null;
  isClosed?: boolean;
}
export interface TallyLeadSource {
  id: string;
  name: string;
  externalFormId?: string | null;
  webhookUrl?: string | null;
  remoteState?: string | null;
  ingestStatus?: string | null;
  isActive?: boolean;
}
export const tallyProviders = () => apiFetch<unknown>('/v1/integrations/providers', { auth: true });
export const tallyConnections = () => apiFetch<TallyConnection[]>('/v1/integrations', { auth: true });
export const tallyConnect = (apiKey: string, label?: string) =>
  apiFetch<TallyConnection>('/v1/integrations', { method: 'POST', body: { provider: 'TALLY', apiKey, label }, auth: true });
export const tallyVerify = (id: string) =>
  apiFetch<TallyConnection>(`/v1/integrations/${id}/verify`, { method: 'POST', auth: true });
export const tallyForms = (id: string) =>
  apiFetch<{ items: TallyForm[]; nextCursor: string | null }>(`/v1/integrations/${id}/forms`, { auth: true });
export const tallyConnectForm = (credentialId: string, externalFormId: string, name?: string) =>
  apiFetch<unknown>('/v1/lead-sources/connect', { method: 'POST', body: { credentialId, externalFormId, name }, auth: true });
export const tallyLeadSources = () => apiFetch<TallyLeadSource[]>('/v1/lead-sources', { auth: true });

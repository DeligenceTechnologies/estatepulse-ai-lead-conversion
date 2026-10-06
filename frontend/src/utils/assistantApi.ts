// EstatePulse AI-agent (Telnyx) API — goes through the shared apiFetch (relative /api,
// Bearer token, org resolved from the JWT server-side). No provider name leaks to the browser.
import { apiFetch } from '../lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One key/value pair, the shape Telnyx uses for headers everywhere. */
export interface ToolHeader {
  name: string;
  value: string;
}

/**
 * A JSON-Schema object describing the arguments the model must supply. Telnyx
 * takes the real thing, so this is a schema and not a bespoke parameter list.
 */
export interface ToolParamSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface WebhookToolParams {
  name: string;
  description: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: ToolHeader[];
  path_parameters?: ToolParamSchema;
  query_parameters?: ToolParamSchema;
  body_parameters?: ToolParamSchema;
  timeout_ms?: number;
}

export interface TransferToolParams {
  from?: string;
  targets: Array<{ name: string; to: string }>;
  custom_headers?: ToolHeader[];
}

export type ToolType = 'webhook' | 'transfer' | 'hangup' | 'send_dtmf' | 'handoff' | 'refer';

export interface AssistantTool {
  type: ToolType | string;
  /**
   * Server-assigned. Present on shared tools (which is how they are detached and
   * tested) and absent on a tool the user has only just built in the form.
   */
  id?: string;
  /**
   * True when this tool lives in the account's shared library and is merely
   * attached here. Read-only: the editor shows those but will not write them
   * back inline, which is what stops a save forking a shared tool into a copy.
   */
  shared?: boolean;
  webhook?: WebhookToolParams;
  transfer?: TransferToolParams;
  hangup?: { description?: string };
  handoff?: { ai_assistants?: string[]; voice_mode?: 'distinct' | 'same' };
  refer?: Record<string, any>;
  [k: string]: any;
}

/** What POST /assistant/tools/:id/test hands back. */
export interface ToolTestResult {
  success: boolean;
  status_code?: number;
  content_type?: string;
  response?: string;
  request?: Record<string, any>;
}

export interface AssistantConfig {
  id: string;
  name: string;
  model: string;
  description: string;
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
  disable_greeting_interruption: boolean;
  /** null means "let the model decide" — distinct from 0. */
  interrupt_prediction_threshold: number | null;
  record_calls: boolean;
  max_call_secs: number;
  user_idle_timeout_secs: number;
  user_idle_reply_secs: number;
  disable_dtmf: boolean;
  noise_suppression: NoiseSuppression;
  fallback_destination: string;
  /** Answering-machine detection: skip the pitch when a machine picks up. */
  voicemail_detection: boolean;
  voicemail_action: VoicemailAction;
  post_call_processing: boolean;
  enabled_features: string[];
  messaging_profile_id: string;
  /** 0 means no timeout. */
  messaging_inactivity_minutes: number;
  data_retention: boolean;
  dynamic_variables: Record<string, string>;
  dynamic_variables_webhook_url: string;
  tools: AssistantTool[];
}

export type NoiseSuppression = 'disabled' | 'krisp' | 'aicoustics' | 'deepfilternet';
export type VoicemailAction = 'hangup' | 'leave_message';

export const NOISE_SUPPRESSION_OPTIONS: Array<{ value: NoiseSuppression; label: string }> = [
  { value: 'disabled', label: 'Off' },
  { value: 'krisp', label: 'Krisp' },
  { value: 'aicoustics', label: 'ai-coustics' },
  { value: 'deepfilternet', label: 'DeepFilterNet' },
];

export type AssistantPatch = Partial<Omit<AssistantConfig, 'id' | 'name'>>;

export interface TelnyxStatus {
  /** The active account: its row id, its name, and how many are on file. */
  accountId: string;
  label: string;
  accountCount: number;
  connected: boolean;
  hasAssistant: boolean;
  hasIntegration?: boolean;
  status?: string;
  apiKeyMasked: string;
  connectionId: string;
  messagingProfileId: string;
  hasMessaging?: boolean;
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
  label?: string;
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

/**
 * One Telnyx account on the shelf. An org may keep several — one per market,
 * say — but exactly one is active at a time, and the active one places every
 * call and message. Switching is the only way another account does anything.
 */
export interface TelnyxAccount {
  id: string;
  label: string;
  apiKeyMasked: string;
  fromNumber: string;
  assistantId: string;
  connectionId: string;
  messagingProfileId: string;
  hasMessaging: boolean;
  active: boolean;
  connectedAt: string | null;
}

// ---- Connection ----
export const getTelnyxStatus = () => apiFetch<TelnyxStatus>('/telnyx/status', { auth: true });
export const listTelnyxAccounts = () =>
  apiFetch<{ accounts: TelnyxAccount[] }>('/telnyx/accounts', { auth: true }).then((d) => d.accounts);
export const addTelnyxAccount = (creds: TelnyxCredentials & { label?: string }) =>
  apiFetch<TelnyxStatus>('/telnyx/accounts', { method: 'POST', body: creds, auth: true });
export const activateTelnyxAccount = (id: string) =>
  apiFetch<TelnyxStatus>(`/telnyx/accounts/${id}/activate`, { method: 'POST', auth: true });
export const renameTelnyxAccount = (id: string, label: string) =>
  apiFetch<{ accounts: TelnyxAccount[] }>(`/telnyx/accounts/${id}`, { method: 'PATCH', body: { label }, auth: true });
export const deleteTelnyxAccount = (id: string) =>
  apiFetch<TelnyxStatus>(`/telnyx/accounts/${id}`, { method: 'DELETE', auth: true });
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

// ---- Tools ----
/**
 * Replaces the assistant's own tools. Pass only the non-shared ones: shared
 * tools are attached by reference and the server re-attaches them afterwards,
 * so including them here would be asking for a private copy.
 */
export const setTools = (tools: AssistantTool[]) =>
  apiFetch<{ assistant: AssistantConfig }>('/assistant/tools', {
    method: 'PUT',
    body: { tools },
    auth: true,
  }).then((d) => d.assistant);

/** Detaches a shared tool. The tool stays in the account library. */
export const detachTool = (toolId: string) =>
  apiFetch<{ assistant: AssistantConfig }>(`/assistant/tools/${toolId}`, {
    method: 'DELETE',
    auth: true,
  }).then((d) => d.assistant);

/** Calls a webhook tool for real with the arguments given. */
export const testTool = (
  toolId: string,
  args: Record<string, unknown>,
  dynamicVariables: Record<string, unknown> = {},
) =>
  apiFetch<{ result: ToolTestResult }>(`/assistant/tools/${toolId}/test`, {
    method: 'POST',
    body: { arguments: args, dynamic_variables: dynamicVariables },
    auth: true,
  }).then((d) => d.result);

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
    const to = t.transfer?.targets?.[0]?.to || (t.transfer as any)?.to || '';
    return `Transfer${to ? ` → ${to}` : ''}`;
  }
  if (t.type === 'webhook') return `Webhook: ${t.webhook?.name || t.webhook?.url || 'unnamed'}`;
  if (t.type === 'hangup') return 'Hang up';
  if (t.type === 'send_dtmf') return 'Send keypad tones';
  if (t.type === 'handoff') return 'Hand off to another agent';
  if (t.type === 'refer') return 'SIP refer';
  return t.type;
}

/** What each tool type is for, in the words of someone running an office. */
export const TOOL_TYPE_INFO: Record<string, { label: string; blurb: string }> = {
  webhook: {
    label: 'Webhook',
    blurb: 'Call your own API mid-conversation — look something up, or report what the agent learned.',
  },
  transfer: {
    label: 'Transfer',
    blurb: 'Hand the live call to a real person on another number.',
  },
  hangup: {
    label: 'Hang up',
    blurb: 'Let the agent end the call itself once the conversation is finished.',
  },
  send_dtmf: {
    label: 'Keypad tones',
    blurb: 'Let the agent press phone keys, for navigating an IVR menu.',
  },
  handoff: {
    label: 'Handoff',
    blurb: 'Pass the conversation to a different AI agent that handles another specialism.',
  },
};

/** A blank, valid tool of the given type — what the editor starts from. */
export function blankTool(type: ToolType): AssistantTool {
  switch (type) {
    case 'webhook':
      return {
        type: 'webhook',
        webhook: {
          name: '',
          description: '',
          url: '',
          method: 'POST',
          headers: [],
          body_parameters: { type: 'object', properties: {}, required: [] },
          timeout_ms: 5000,
        },
      };
    case 'transfer':
      return { type: 'transfer', transfer: { targets: [{ name: '', to: '' }], custom_headers: [] } };
    case 'hangup':
      return { type: 'hangup', hangup: { description: '' } };
    case 'handoff':
      return { type: 'handoff', handoff: { ai_assistants: [], voice_mode: 'same' } };
    default:
      return { type };
  }
}

/**
 * The variables the backend actually sends when a call is answered, in the same
 * order the prompt tends to want them.
 *
 * Kept deliberately in step with ActivityService.callVariables — a picker that
 * offers a variable nothing populates is worse than no picker, because the
 * prompt then renders the braces out loud.
 */
export const LEAD_VARIABLES: Array<{ name: string; example: string }> = [
  { name: 'firstName', example: 'Dana' },
  { name: 'lastName', example: 'Whitfield' },
  { name: 'fullName', example: 'Dana Whitfield' },
  { name: 'email', example: 'dana@example.com' },
  { name: 'phone', example: '+15125550147' },
  { name: 'location', example: 'North Austin' },
  { name: 'budget', example: '450,000 to 600,000' },
  { name: 'bedrooms', example: '3' },
  { name: 'timeline', example: '3-6 months' },
  { name: 'financingStatus', example: 'pre-approved' },
  { name: 'temperature', example: 'warm' },
  { name: 'motivation', example: 'relocating for work' },
  { name: 'brokerage', example: 'Austin Home Advisors' },
  { name: 'leadId', example: 'a3f1…' },
];

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

// ---- Lead flow: where the lead is in its journey (strategy step vs follow-up) ----
export interface LeadFlowStep {
  index: number;
  channel: string;   // 'sms' | 'voice'
  action: string;    // 'send_sms' | 'ai_call' | ...
  after: { value: number; unit: string };
  state: 'done' | 'failed' | 'current' | 'pending';
  outcome: string | null; // 'SMS sent' | 'SMS failed' | 'Answered' | 'No answer' | 'Call failed' | null
}
export interface LeadFlow {
  phase: 'not_started' | 'strategy' | 'exited' | 'done';
  leadStatus: string;
  outcome: string; // best real-world result so far: 'Call answered' | 'SMS sent' | 'Exited strategy…' | …
  strategyName: string;
  stepsTotal: number;
  completed: number;
  currentStep: LeadFlowStep | null;
  steps: LeadFlowStep[];
  reason: string | null;
}
export const getLeadFlow = (id: string) => apiFetch<LeadFlow>(`/leads/${id}/flow`, { auth: true });
/** Start the strategy now. A no-op server-side for a lead already contacted. */
export const enrollLead = (id: string) =>
  apiFetch<{ ok: boolean }>(`/leads/${id}/enroll`, { method: 'POST', auth: true });

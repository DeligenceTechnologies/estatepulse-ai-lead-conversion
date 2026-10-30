import { ApiError, apiFetch, messageFor } from '../lib/api';
import type { SmsCapability } from './callingProviderApi';

/**
 * Retell's own reason when it refused a request (the API answers 502 with it),
 * e.g. "Retell: Voice … is only supported with …"; otherwise the usual wording.
 */
export const retellMessage = (e: unknown): string =>
  e instanceof ApiError && e.status === 502 && e.message ? e.message.replace(/^Retell \S+ \S+ failed \d+: /, 'Retell: ') : messageFor(e);

/** The organization's Retell account. Every route answers 404 unless RETELL_ENABLED. */
export interface RetellStatus {
  connected: boolean;
  /** True when the organization calls through Retell now. */
  active: boolean;
  apiKeyMasked: string;
  hasWebhookKey: boolean;
  agentId: string;
  /** The chat agent that texts for the organization; empty until SMS is set up. */
  smsAgentId: string;
  fromNumber: string;
  connectedAt: string | null;
}

/** A tool on the agent's Retell LLM. `managed` ones are EstatePulse's (booking, callbacks, outcomes): shown, not editable. */
export interface RetellTool {
  type: string;
  name: string;
  description?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  parameters?: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] };
  transfer_destination?: { type: 'predefined'; number: string } | { type: 'inferred'; prompt: string };
  transfer_option?: { type: string };
  timeout_ms?: number;
  managed: boolean;
}

export interface RetellAgent {
  agentId: string;
  llmId: string;
  name: string;
  prompt: string;
  greeting: string;
  voiceId: string;
  language: string;
  maxCallSeconds: number;
  voicemailHangup: boolean;
  recordCalls: boolean;
  /** Retell analyses each finished call and sends it over; off, nothing is scored. */
  postCallProcessing: boolean;
  /** {{key}} defaults in the prompt; the lead's own details always win on a call. */
  dynamicVariables: Record<string, string>;
  tools: RetellTool[];
}

export type RetellAgentPatch = Partial<Omit<RetellAgent, 'agentId' | 'llmId' | 'tools'>>;

/** Replaces the agent's own tools (managed ones stay); saved at once. */
export const setRetellAgentTools = (tools: Omit<RetellTool, 'managed'>[]) =>
  apiFetch<{ agent: RetellAgent }>('/retell/agent/tools', { method: 'PUT', body: { tools }, auth: true }).then((d) => d.agent);

export interface RetellVoice {
  id: string;
  name: string;
  provider: string;
  gender: string;
  accent: string;
  previewUrl: string;
}

export interface RetellNumber {
  phoneNumber: string;
  type: string;
  nickname: string;
  routedToAgent: boolean;
  fromNumber: boolean;
}

export interface RetellCallCapacity {
  appLimit: number;
  retellLimit: number | null;
  inUse: number;
  retellError: string | null;
}

/** Texting through Retell: what the calling number can do, as Retell describes it. */
export interface RetellSmsStatus {
  capability: SmsCapability;
  smsAgentId: string;
  fromNumber: string;
  number: {
    /** retell-twilio | retell-telnyx | custom */
    type: string;
    terminationUri: string;
    inboundSmsAgents: string[];
    outboundSmsAgents: string[];
    inboundSmsWebhookUrl: string | null;
  } | null;
  numberError: string | null;
  registrationNote: string;
}

export interface RetellSmsAgent {
  agentId: string;
  llmId: string;
  prompt: string;
}

export const getRetellStatus = () => apiFetch<RetellStatus>('/retell/status', { auth: true });

export const connectRetell =(keys: { apiKey?: string; webhookKey?: string }) =>
  apiFetch<RetellStatus & { workspace: string }>('/retell/credentials', { method: 'PUT', body: keys, auth: true });

export const disconnectRetell = () => apiFetch<RetellStatus>('/retell/credentials', { method: 'DELETE', auth: true });

export const listRetellVoices = () => apiFetch<{ voices: RetellVoice[] }>('/retell/voices', { auth: true }).then((d) => d.voices);

export const getRetellAgent = () => apiFetch<{ agent: RetellAgent | null }>('/retell/agent', { auth: true }).then((d) => d.agent);

export const createRetellAgent = (body: { name?: string; voiceId?: string; language?: string }) =>
  apiFetch<{ agent: RetellAgent }>('/retell/agent', { method: 'POST', body, auth: true }).then((d) => d.agent);

export const updateRetellAgent = (patch: RetellAgentPatch) =>
  apiFetch<{ agent: RetellAgent }>('/retell/agent', { method: 'PATCH', body: patch, auth: true }).then((d) => d.agent);

/** A voice agent on the Retell workspace; `current` is the one the organization uses. */
export interface RetellAgentSummary {
  agentId: string;
  name: string;
  current: boolean;
}

export const listRetellAgents = () => apiFetch<{ agents: RetellAgentSummary[] }>('/retell/agents', { auth: true }).then((d) => d.agents);

/** Makes an agent built in the Retell dashboard the organization's (single-prompt agents only). */
export const useRetellAgent = (agentId: string) =>
  apiFetch<{ agent: RetellAgent }>('/retell/agent/use', { method: 'POST', body: { agentId }, auth: true }).then((d) => d.agent);

export const listRetellNumbers = () => apiFetch<{ numbers: RetellNumber[] }>('/retell/numbers', { auth: true }).then((d) => d.numbers);

export const buyRetellNumber = (body: { areaCode?: number; countryCode?: 'US' | 'CA'; tollFree?: boolean }) =>
  apiFetch<{ phoneNumber: string }>('/retell/numbers/buy', { method: 'POST', body, auth: true });

export const importRetellNumber = (body: { phoneNumber: string; terminationUri: string; username?: string; password?: string }) =>
  apiFetch<{ phoneNumber: string }>('/retell/numbers/import', { method: 'POST', body, auth: true });

export const assignRetellNumber = (phoneNumber: string) =>
  apiFetch<RetellStatus>('/retell/numbers/assign', { method: 'POST', body: { phoneNumber }, auth: true });

/** Clears the number calls come from, so another can be chosen; nothing changes on Retell. */
export const unassignRetellNumber = () => apiFetch<RetellStatus>('/retell/numbers/unassign', { method: 'POST', auth: true });

export const getRetellCallCapacity = () => apiFetch<RetellCallCapacity>('/retell/call-capacity', { auth: true });

export const saveRetellCallCapacity = (maxConcurrentCalls: number) =>
  apiFetch<RetellCallCapacity>('/retell/call-capacity', { method: 'PUT', body: { maxConcurrentCalls }, auth: true });

export const getRetellSms = () => apiFetch<RetellSmsStatus>('/retell/sms', { auth: true });

/** Creates the SMS agent once and binds it to the calling number; safe to run again to finish or repair a setup. */
export const setupRetellSms = () => apiFetch<RetellSmsStatus>('/retell/sms/setup', { method: 'POST', auth: true });

export const disableRetellSms = () => apiFetch<RetellSmsStatus>('/retell/sms', { method: 'DELETE', auth: true });

export const getRetellSmsAgent = () => apiFetch<{ agent: RetellSmsAgent | null }>('/retell/sms/agent', { auth: true }).then((d) => d.agent);

export const updateRetellSmsAgent = (prompt: string) =>
  apiFetch<{ agent: RetellSmsAgent }>('/retell/sms/agent', { method: 'PATCH', body: { prompt }, auth: true }).then((d) => d.agent);

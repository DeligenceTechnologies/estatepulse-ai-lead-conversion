import { apiFetch } from '../lib/api';

export interface AssistantSettings {
  enabled: boolean;
  /** US dollars a month; null uses the plan's allowance. */
  monthlyLimitUsd: number | null;
  voiceEnabled: boolean;
}

export interface AssistantUsage {
  period: string;
  usedMicros: number;
  budgetMicros: number;
  planBudgetMicros: number;
  officeLimitMicros: number | null;
  requests: number;
}

export interface AssistantSettingsView {
  settings: AssistantSettings;
  usage: AssistantUsage;
  /** The roles that may use the assistant (assistant.use), Owner first. Set on the Roles screen. */
  rolesWithAccess?: string[];
  /** Whether the assistant is switched on for this server at all. */
  serverEnabled: boolean;
  canEdit: boolean;
}

export interface AssistantLogEntry {
  id: string;
  at: string;
  user: string | null;
  tool: string;
  what: string;
  tier: 'read' | 'write';
  status: 'proposed' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';
  error: string | null;
}

export const getAssistantSettings = () => apiFetch<AssistantSettingsView>('/v1/assistant/settings', { auth: true });
export const updateAssistantSettings = (patch: Partial<AssistantSettings>) =>
  apiFetch<AssistantSettingsView>('/v1/assistant/settings', { method: 'PUT', auth: true, body: patch });
export const getAssistantLog = (before?: string) =>
  apiFetch<{ entries: AssistantLogEntry[]; nextCursor: string | null }>(`/v1/assistant/log${before ? `?before=${encodeURIComponent(before)}` : ''}`, { auth: true });

/** "$12.40" from micro-dollars. */
export const usd = (micros: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(micros / 1_000_000);

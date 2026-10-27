import { apiFetch } from '../lib/api';

/**
 * The AI's call-outcome tools, on a call and in a text chat: schedule_callback
 * (calls the lead back at the exact time they asked for, with nothing else
 * sent before it) and record_outcome (not interested, do not contact, wrong
 * number — recorded the moment the lead says it).
 */
export interface CallToolsStatus {
  enabled: boolean;
  /** After a call on which a callback was set, text the lead the time. */
  confirmSms: boolean;
  /** {{firstName}}, {{callbackTime}} and the other lead variables are filled in. */
  confirmMessage: string;
  defaultConfirmMessage: string;
  /** The tools are on the assistant and point at this server. */
  active: boolean;
  problem: string | null;
}

export const getCallTools = () => apiFetch<CallToolsStatus>('/call-tools', { auth: true });

/** An empty message restores the default one. */
export const updateCallTools = (patch: { enabled?: boolean; confirmSms?: boolean; confirmMessage?: string }) =>
  apiFetch<CallToolsStatus>('/call-tools', { method: 'PUT', body: patch, auth: true });

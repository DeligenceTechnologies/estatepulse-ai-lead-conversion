import { apiFetch } from '../lib/api';

/**
 * What an AI call leaves when an answering machine picks up. The assistant
 * never talks to a machine; with this on, the message is spoken after the
 * beep, then the call ends and counts as not answered.
 */
export interface VoicemailStatus {
  enabled: boolean;
  /** {{firstName}}, {{brokerage}} and the other lead variables are filled in per call. */
  message: string;
  defaultMessage: string;
}

export const getVoicemail = () => apiFetch<VoicemailStatus>('/voicemail', { auth: true });

/** An empty message restores the default one. */
export const updateVoicemail = (patch: { enabled?: boolean; message?: string }) =>
  apiFetch<VoicemailStatus>('/voicemail', { method: 'PUT', body: patch, auth: true });

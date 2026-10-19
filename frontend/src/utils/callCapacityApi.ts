import { apiFetch } from '../lib/api';

export interface CallCapacity {
  appLimit: number;
  telnyxLimit: number | null;
  inUse: number;
  inSync: boolean;
  connected: boolean;
  profileName: string | null;
  telnyxError: string | null;
}

export const getCallCapacity = () => apiFetch<CallCapacity>('/telnyx/call-capacity', { auth: true });

export const saveCallCapacity = (maxConcurrentCalls: number) =>
  apiFetch<CallCapacity>('/telnyx/call-capacity', { method: 'PUT', body: { maxConcurrentCalls }, auth: true });

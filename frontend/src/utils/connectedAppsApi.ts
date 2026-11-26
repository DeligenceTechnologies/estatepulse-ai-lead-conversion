import { apiFetch } from '../lib/api';

/** connected: working. needs_reconnect: someone has to sign in again. error: failing for another reason. syncing: a sync is running. */
export type AppState = 'connected' | 'needs_reconnect' | 'error' | 'syncing';

export interface ConnectedApp {
  id: string;
  provider: string;
  label: string;
  /** Shown only to people who may see integrations. */
  account: string | null;
  state: AppState;
  lastSyncAt: string | null;
  message: string | null;
  /** The app page where it is fixed, e.g. "/settings?tab=calendar". */
  reconnectPath: string;
}

export interface ConnectedAppsDTO {
  apps: ConnectedApp[];
  canReconnect: boolean;
}

export const getConnectedApps = () => apiFetch<ConnectedAppsDTO>('/v1/integrations/status', { auth: true });

export const isBroken = (a: ConnectedApp): boolean => a.state === 'needs_reconnect' || a.state === 'error';

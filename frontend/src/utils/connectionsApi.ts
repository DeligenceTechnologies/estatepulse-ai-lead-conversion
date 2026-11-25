import { apiFetch } from '../lib/api';
import { runNangoConnect, type NangoSession } from '../lib/nangoConnect';

/**
 * Every outside account, connected the same way: the backend hands out a
 * Nango Connect session, the person signs in (or enters an API key) in
 * Nango's window, and the backend links the connection id Nango returns.
 * No token or key ever reaches this page.
 */

export type ProviderKey = 'google' | 'airtable' | 'hubspot' | 'typeform' | 'tally' | 'calendly' | 'cal' | 'telnyx';
export type ConnectionCategory = 'leads' | 'crm' | 'calendar' | 'calling';
export type ConnectionState = 'connected' | 'needs_setup' | 'broken';

export interface ConnectionView {
  id: string;
  provider: ProviderKey;
  state: ConnectionState;
  label: string | null;
  accountEmail: string | null;
  accountName: string | null;
  /** A masked API key, or 'oauth'. */
  preview: string | null;
  errorCode: string | null;
  connectedAt: string;
  lastVerifiedAt: string | null;
  /** Provider-specific facts for the card (Telnyx: active, fromNumber; Airtable: permissions…). */
  details: Record<string, unknown>;
}

export interface ProviderView {
  key: ProviderKey;
  label: string;
  description: string;
  category: ConnectionCategory;
  auth: 'oauth' | 'apiKey';
  /** Several accounts can be connected (Airtable, Tally, Typeform, Telnyx). */
  multiple: boolean;
  /** Why it cannot be connected right now (server setting, plan), or null. */
  unavailable: string | null;
  connections: ConnectionView[];
}

export const listConnections = (): Promise<ProviderView[]> => apiFetch<ProviderView[]>('/connections', { auth: true });

/**
 * Runs Nango Connect for one provider and links the result. With
 * `reconnectId` it repairs that connection in place. Resolves null when the
 * window was closed without connecting. Call it from a click: the window opens
 * straight away.
 */
export async function connectProvider(
  provider: ProviderKey,
  options: { reconnectId?: string; signal?: AbortSignal } = {},
): Promise<ConnectionView | null> {
  const connectionId = await runNangoConnect(
    () =>
      apiFetch<NangoSession>(`/connections/${provider}/session`, {
        method: 'POST',
        auth: true,
        body: options.reconnectId ? { reconnectId: options.reconnectId } : {},
      }),
    options.signal,
  );
  if (!connectionId) return null;
  return apiFetch<ConnectionView>(`/connections/${provider}/complete`, { method: 'POST', auth: true, body: { connectionId } });
}

/** Stops using the account and deletes its credential. `force` confirms a disconnect the first try warned about. */
export const disconnectConnection = (id: string, force = false): Promise<void> =>
  apiFetch<void>(`/connections/${id}${force ? '?force=true' : ''}`, { method: 'DELETE', auth: true });

/** The organization's live connections for one provider. */
export async function connectionsOf(provider: ProviderKey): Promise<ConnectionView[]> {
  return (await listConnections()).find((p) => p.key === provider)?.connections ?? [];
}

/** The old per-provider status words some screens still show. */
export const legacyStatus = (state: ConnectionState): 'ACTIVE' | 'INVALID' | 'INACTIVE' =>
  state === 'broken' ? 'INVALID' : state === 'needs_setup' ? 'INACTIVE' : 'ACTIVE';

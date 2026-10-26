import { useEffect, useState } from 'react';
import { ApiError, apiFetch, getToken } from '../lib/api';

/**
 * Which provider the organization calls through: Telnyx or Retell, never both.
 * The server answers 404 everywhere unless RETELL_ENABLED; then every
 * organization is on Telnyx exactly as before and nothing Retell shows.
 */
export type CallingProviderName = 'telnyx' | 'retell';

export interface CallingProviderState {
  /** False when Retell is switched off on this server. */
  enabled: boolean;
  provider: CallingProviderName;
  capabilities: { sms: boolean };
}

export interface SwitchPreview {
  from: CallingProviderName;
  to: CallingProviderName;
  liveCalls: number;
  /** Any of these refuses the switch. */
  blockers: string[];
  warnings: string[];
}

export const PROVIDER_LABEL: Record<CallingProviderName, string> = { telnyx: 'Telnyx', retell: 'Retell' };

/** Shown wherever an SMS step is offered to an organization on Retell. */
export const SMS_UNAVAILABLE_ON_RETELL = 'SMS follow-ups are not available with Retell.';

const TELNYX_ONLY: CallingProviderState = { enabled: false, provider: 'telnyx', capabilities: { sms: true } };

/** Keyed by the session token, so signing in to another organization asks again. */
let cached: { token: string | null; answer: Promise<CallingProviderState> } | null = null;

/** Asked once per session and shared by every screen; a switch replaces it. */
export const getCallingProvider = (): Promise<CallingProviderState> => {
  const token = getToken();
  if (cached?.token !== token) {
    const answer = apiFetch<Omit<CallingProviderState, 'enabled'>>('/calling-provider', { auth: true }).then(
      (s) => ({ ...s, enabled: true }),
      (e) => {
        if (e instanceof ApiError && e.status === 404) return TELNYX_ONLY;
        if (cached?.answer === answer) cached = null; // a transient failure is asked again next time
        return TELNYX_ONLY;
      },
    );
    cached = { token, answer };
  }
  return cached!.answer;
};

export const getSwitchPreview = (to: CallingProviderName) =>
  apiFetch<SwitchPreview>(`/calling-provider/switch-preview?provider=${to}`, { auth: true });

export const switchCallingProvider = async (provider: CallingProviderName): Promise<SwitchPreview> => {
  const result = await apiFetch<SwitchPreview>('/calling-provider', { method: 'PUT', body: { provider }, auth: true });
  cached = { token: getToken(), answer: Promise.resolve({ enabled: true, provider, capabilities: { sms: provider === 'telnyx' } }) };
  return result;
};

/** The organization's provider; null until known. */
export function useCallingProvider(): CallingProviderState | null {
  const [state, setState] = useState<CallingProviderState | null>(null);
  useEffect(() => {
    let live = true;
    void getCallingProvider().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

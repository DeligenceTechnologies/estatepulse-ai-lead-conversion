import { useEffect, useState } from 'react';
import { ApiError, apiFetch, getToken } from '../lib/api';

/**
 * Which provider the organization calls through: Telnyx or Retell, never both.
 * The server answers 404 everywhere unless RETELL_ENABLED; then every
 * organization is on Telnyx exactly as before and nothing Retell shows.
 */
export type CallingProviderName = 'telnyx' | 'retell';

/**
 * Whether the provider can text for this organization right now, as the
 * server read it: ready (Telnyx), unverified (Retell with its SMS agent on an
 * eligible number, whose A2P registration Retell does not report), or one of
 * the reasons it cannot.
 */
export type SmsReadiness = 'ready' | 'unverified' | 'not_configured' | 'no_number' | 'unsupported_number' | 'unavailable';

export interface SmsCapability {
  /** A text can be attempted now. */
  available: boolean;
  state: SmsReadiness;
  /** Why not, or what cannot be verified; null when ready. */
  reason: string | null;
  /** The provider reports delivered / failed per message (Telnyx); Retell only accepts the chat. */
  deliveryReports: boolean;
}

export interface CallingProviderState {
  /** False when Retell is switched off on this server. */
  enabled: boolean;
  provider: CallingProviderName;
  capabilities: { sms: boolean };
  sms: SmsCapability;
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

export const SMS_READY: SmsCapability = { available: true, state: 'ready', reason: null, deliveryReports: true };
/** The fallback wording when the server gives no reason of its own. */
export const SMS_UNAVAILABLE = 'SMS is not set up for this calling provider.';

/** Why SMS steps are not sent for this organization; undefined when they are. Shown wherever an SMS step appears. */
export const smsDisabledReasonOf = (state: CallingProviderState | null): string | undefined =>
  state && !state.sms.available ? (state.sms.reason ?? SMS_UNAVAILABLE) : undefined;

const TELNYX_ONLY: CallingProviderState = { enabled: false, provider: 'telnyx', capabilities: { sms: true }, sms: SMS_READY };

/** Keyed by the session token, so signing in to another organization asks again. */
let cached: { token: string | null; answer: Promise<CallingProviderState> } | null = null;

const fetchState = (): Promise<CallingProviderState> =>
  apiFetch<Omit<CallingProviderState, 'enabled'>>('/calling-provider', { auth: true }).then((s) => ({ ...s, sms: s.sms ?? (s.capabilities.sms ? SMS_READY : { ...SMS_READY, available: false, state: 'unavailable', reason: SMS_UNAVAILABLE }), enabled: true }));

/** Asked once per session and shared by every screen; a switch or an SMS setup asks again. */
export const getCallingProvider = (): Promise<CallingProviderState> => {
  const token = getToken();
  if (cached?.token !== token) {
    const answer = fetchState().catch((e) => {
      if (e instanceof ApiError && e.status === 404) return TELNYX_ONLY;
      if (cached?.answer === answer) cached = null; // a transient failure is asked again next time
      return TELNYX_ONLY;
    });
    cached = { token, answer };
  }
  return cached!.answer;
};

/** Forgets the cached answer: the next screen asks the server again (after a switch, or SMS being set up). */
export const refreshCallingProvider = (): Promise<CallingProviderState> => {
  cached = null;
  return getCallingProvider();
};

export const getSwitchPreview = (to: CallingProviderName) =>
  apiFetch<SwitchPreview>(`/calling-provider/switch-preview?provider=${to}`, { auth: true });

export const switchCallingProvider = async (provider: CallingProviderName): Promise<SwitchPreview> => {
  const result = await apiFetch<SwitchPreview>('/calling-provider', { method: 'PUT', body: { provider }, auth: true });
  // What the new provider can send is the server's to say, so every screen asks it again.
  cached = null;
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

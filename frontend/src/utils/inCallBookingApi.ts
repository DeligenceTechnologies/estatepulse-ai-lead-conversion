import { apiFetch } from '../lib/api';

/**
 * In-call booking: the AI books a meeting on the office's Calendly round-robin
 * event type during a live call. Owner-only on the server.
 */
export interface InCallBookingStatus {
  enabled: boolean;
  eventType: { uri: string; name: string; durationMinutes: number } | null;
  calendly: { connected: boolean; scopesOk: boolean };
  telnyx: { connected: boolean; hasAssistant: boolean };
  /** Round-robin event types the owner may choose. */
  eventTypes: { uri: string; name: string; durationMinutes: number }[];
  /** Calendly members not linked to an agent. */
  unlinkedMembers: string[];
  problem: string | null;
}

export const getInCallBooking = () => apiFetch<InCallBookingStatus>('/in-call-booking', { auth: true });

export const enableInCallBooking = (eventTypeUri: string) =>
  apiFetch<InCallBookingStatus>('/in-call-booking', { method: 'PUT', body: { eventTypeUri }, auth: true });

export const disableInCallBooking = () =>
  apiFetch<InCallBookingStatus>('/in-call-booking/disable', { method: 'POST', auth: true });

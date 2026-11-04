import { apiFetch } from '../lib/api';

/**
 * Whether the AI assistant answers a lead's texts. On: the AI chats, the
 * strategy holds its call until the chat goes quiet, and a clear "no" or a
 * wrong number in a text is recorded. Off: a reply pauses automation for a person.
 */
export interface SmsConversationStatus {
  enabled: boolean;
  assistantId: string | null;
  messagingProfileId: string | null;
  enabledAt: string | null;
  /** In-call booking is on, so the AI can book a meeting in the chat too. */
  bookingInChat: boolean;
  engine: SmsReplyEngine;
}

/**
 * Who writes the AI's text replies. 'telnyx': the assistant linked to the
 * number answers every text itself. 'estatepulse': EstatePulse decides per
 * text whether the AI answers (not for agents' chats, booked or opted-out
 * leads, unknown numbers) and writes the reply with the same assistant.
 */
export type SmsReplyEngine = 'telnyx' | 'estatepulse';

export const setSmsReplyEngine = (engine: SmsReplyEngine) =>
  apiFetch<SmsConversationStatus>('/sms-conversation/engine', { method: 'PUT', body: { engine }, auth: true });

export const getSmsConversation = () => apiFetch<SmsConversationStatus>('/sms-conversation', { auth: true });

export const enableSmsConversation = () => apiFetch<SmsConversationStatus>('/sms-conversation', { method: 'PUT', auth: true });

export const disableSmsConversation = () =>
  apiFetch<SmsConversationStatus>('/sms-conversation/disable', { method: 'POST', auth: true });

/** What is texted to a lead when an agent takes their chat over, so they know a person is answering now. */
export interface TakeoverGreeting {
  enabled: boolean;
  message: string;
  defaultMessage: string;
}

export const getTakeoverGreeting = () => apiFetch<TakeoverGreeting>('/sms-conversation/takeover-greeting', { auth: true });

/** An empty message restores the default. */
export const updateTakeoverGreeting = (patch: { enabled?: boolean; message?: string }) =>
  apiFetch<TakeoverGreeting>('/sms-conversation/takeover-greeting', { method: 'PUT', body: patch, auth: true });

/**
 * Who the organization is in its texts. Outreach texts to Canadian numbers
 * name the brokerage and our number; the HELP answer adds the mailing address
 * and the email or website. '' when a field is not set.
 */
export interface BusinessDetails {
  legalName: string;
  mailingAddress: string;
  email: string;
  website: string;
}

export interface BusinessDetailsView extends BusinessDetails {
  /** The mailing address is there: Canada's anti-spam law (CASL) wants it within reach of the lead. */
  complete: boolean;
  /** What {{brokerage}} becomes, and the number texts go out from: for the editors' preview. */
  brokerage: string;
  ourNumber: string | null;
}

export const getBusinessDetails = () => apiFetch<BusinessDetailsView>('/sms-conversation/business-details', { auth: true });

/** Only the fields given change; an empty one clears it. */
export const updateBusinessDetails = (patch: Partial<BusinessDetails>) =>
  apiFetch<BusinessDetailsView>('/sms-conversation/business-details', { method: 'PUT', body: patch, auth: true });

/** Sent on window when the details are saved, so an editor on the same page drops its "address missing" warning. */
export const BUSINESS_DETAILS_SAVED = 'business-details-saved';

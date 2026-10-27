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
}

export const getSmsConversation = () => apiFetch<SmsConversationStatus>('/sms-conversation', { auth: true });

export const enableSmsConversation = () => apiFetch<SmsConversationStatus>('/sms-conversation', { method: 'PUT', auth: true });

export const disableSmsConversation = () =>
  apiFetch<SmsConversationStatus>('/sms-conversation/disable', { method: 'POST', auth: true });

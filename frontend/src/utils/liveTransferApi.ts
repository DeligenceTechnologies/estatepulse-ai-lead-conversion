import { apiFetch } from '../lib/api';

/**
 * Live call transfer: on an AI call, a ready lead (or one who asks for a person) is put through
 * to an available agent. Agents are rung one after another and the lead is put through as soon as
 * one picks up (a voicemail is skipped); when nobody does, the AI comes back and books a meeting, or sets a callback.
 */
export interface LiveTransferSettings {
  enabled: boolean;
  /** Seconds each agent's phone rings before the next one is tried. */
  ringSeconds: number;
  /** Agents tried, one after another, before the AI books a meeting instead. */
  agentsPerTransfer: number;
  /** Transfer a lead who is ready to move: pre-approved, a budget, wants a showing. */
  onHotLead: boolean;
  /** Transfer a lead who asks to speak to a person. */
  onRequest: boolean;
  /** What the lead hears while agents are rung. */
  holdMessage: string;
}

export interface LiveTransferStatus extends LiveTransferSettings {
  defaultHoldMessage: string;
  /** Active agents opted in to live transfers, and how many have a phone number. */
  agents: { optedIn: number; withPhone: number };
  problem: string | null;
}

/** The ranges the server accepts. */
export const LIVE_TRANSFER_LIMITS = {
  ringSeconds: { min: 10, max: 45 },
  agentsPerTransfer: { min: 1, max: 5 },
  holdMessage: 300,
} as const;

export const getLiveTransfer = () => apiFetch<LiveTransferStatus>('/live-transfer', { auth: true });

/** An empty hold message restores the default one. */
export const updateLiveTransfer = (patch: Partial<LiveTransferSettings>) =>
  apiFetch<LiveTransferStatus>('/live-transfer', { method: 'PUT', body: patch, auth: true });

export type TransferStatus = 'dialing' | 'connected' | 'no_agent' | 'abandoned' | 'failed';
export type AttemptStatus = 'dialing' | 'answered' | 'accepted' | 'declined' | 'no_answer' | 'busy' | 'voicemail' | 'failed' | 'cancelled';

export interface CallTransferRow {
  id: string;
  leadId: string;
  leadName: string;
  callId: string;
  status: TransferStatus;
  reason: 'hot_lead' | 'requested_agent';
  facts: { budget?: string; location?: string; preApproved?: boolean; showing?: string; summary?: string };
  fallback: 'booking' | 'callback' | null;
  connectedUserId: string | null;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  attempts: { position: number; userId: string; agentName: string; status: AttemptStatus; hangupCause: string | null; dialedAt: string; answeredAt: string | null; endedAt: string | null }[];
}

/** The latest transfers, newest first; `leadId` narrows to one lead. */
export const listCallTransfers = (leadId?: string) =>
  apiFetch<CallTransferRow[]>(`/live-transfer/transfers${leadId ? `?leadId=${encodeURIComponent(leadId)}` : ''}`, { auth: true });

import { apiFetch } from '../lib/api';

/**
 * The business facts the AI answers a lead's questions from — areas served,
 * commission, lender partners, common objections.
 *
 * They are written into the assistant's own instructions, and Telnyx answers
 * texts with those same instructions, so one list serves calls and text chats
 * alike. Anything the list does not cover, the AI says it will check and have
 * an agent confirm rather than guessing.
 */

export interface KnowledgeEntry {
  /** A question ("Do you handle rentals?") or a topic ("Areas served"). */
  title: string;
  /** What the AI should say about it. */
  body: string;
}

export interface KnowledgeLimits {
  maxEntries: number;
  titleMaxChars: number;
  bodyMaxChars: number;
  /** Titles and answers together: the facts ride in the prompt on every call. */
  totalMaxChars: number;
}

export interface KnowledgeStatus {
  entries: KnowledgeEntry[];
  size: number;
  limits: KnowledgeLimits;
}

export const getKnowledge = () => apiFetch<KnowledgeStatus>('/knowledge', { auth: true });

export const saveKnowledge = (entries: KnowledgeEntry[]) =>
  apiFetch<KnowledgeStatus & { warning: string | null }>('/knowledge', {
    method: 'PUT',
    auth: true,
    body: { entries: entries.map((e) => ({ title: e.title.trim(), body: e.body.trim() })) },
  });

/** What the entries cost against `totalMaxChars`, for the editor's counter. */
export const knowledgeSize = (entries: KnowledgeEntry[]): number =>
  entries.reduce((n, e) => n + e.title.trim().length + e.body.trim().length, 0);

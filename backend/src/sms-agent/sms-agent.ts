import { LeadStatus, type MessageDirection, type MessageSender } from '@prisma/client';
import { linksIn } from '@/telnyx/lead-data';
import { AGENT_MESSAGE_PREFIX, agentMessageForAi } from '@/telnyx/sms/sms-prompt';

/**
 * The parts of this server's AI text replies that need no database or
 * network: who answers a text, the prompt, the chat as the model reads it,
 * the tools it may use, and the reply as it may be sent.
 */

/**
 * Statuses at which the lead's own agent, when it has one who can answer,
 * replies instead of the AI (user's decision, 2026-11-04): agents are
 * assigned at booking, and only the assigned agent may take a chat over.
 */
export const AGENT_ANSWERS: LeadStatus[] = [LeadStatus.appointment_booked, LeadStatus.closed, LeadStatus.not_interested, LeadStatus.invalid];

/** On the lead's review flag while a text from it needs the owner's eye. Cleared when an agent texts the lead. */
export const PERSON_REPLY_REVIEW = 'Texted us and needs a reply from a person: answer in Conversations';
/** On the review flag when the AI could not answer a text. */
export const AI_REPLY_FAILED_REVIEW = 'The AI could not answer a text: answer in Conversations';
/** On the review flag when the AI stopped answering a lead that texts without end (another bot, a loop). */
export const AI_REPLY_CAPPED_REVIEW = 'The AI stopped answering: too many texts in an hour. Answer in Conversations';
/** On a lead made from a number that texted us without being one: the owner looks at it, while the AI answers (user's decision, 2026-11-04). */
export const STRANGER_REVIEW = 'Texted us from a number that was not a lead: answer in Conversations';
/** The flags an agent's text to the lead answers, so they come off then. A capped AI stays capped: it may be a bot. */
export const REPLY_NEEDED_REVIEWS = [PERSON_REPLY_REVIEW, AI_REPLY_FAILED_REVIEW, STRANGER_REVIEW];

/** Who answers a lead's text, and whether the owner is flagged as well. */
export type ReplyRoute = { by: 'ai'; flagOwner: boolean } | { by: 'person'; reason: string; flagOwner: boolean };

/**
 * Who answers this lead's text, judged on the lead as the text found it (a
 * "no thanks" in the same text still gets the AI's one polite reply):
 * - an agent who took the chat over answers it;
 * - nobody texts an opted-out lead, and the owner is flagged;
 * - a booked, closed, not-interested or wrong-number lead whose agent can
 *   reply is left to that agent, who sees it in their Conversations;
 * - any other text the AI answers. A booked lead with no agent also flags the
 *   owner, since someone should follow up on the meeting.
 * `agentCanReply`: the lead's assigned agent is active and holds the Agent role.
 */
export function replyRoute(lead: { status: LeadStatus; dncStatus: boolean; takenOverById: string | null; agentCanReply: boolean }): ReplyRoute {
  if (lead.takenOverById) return { by: 'person', reason: 'an agent has taken the chat over', flagOwner: false };
  if (lead.dncStatus) return { by: 'person', reason: 'the lead opted out', flagOwner: true };
  if (AGENT_ANSWERS.includes(lead.status) && lead.agentCanReply) {
    return { by: 'person', reason: `the lead is ${lead.status.replace(/_/g, ' ')} and its agent answers`, flagOwner: false };
  }
  return { by: 'ai', flagOwner: lead.status === LeadStatus.appointment_booked };
}

/**
 * What the AI should know about where the lead stands before it answers, for
 * the leads it answers outside the usual chat; '' for an active lead.
 */
export function standingNote(status: LeadStatus, stranger: boolean): string {
  if (stranger) {
    return 'This number is not one of our leads yet. Greet them, ask how we can help and their name, and do not assume they asked about buying a home.';
  }
  switch (status) {
    case LeadStatus.not_interested:
      return 'Earlier this lead told us they were not interested. Answer politely; ask about their search or offer a meeting only if they now say they are interested, and never pressure them.';
    case LeadStatus.invalid:
      return 'Earlier this number was marked as a wrong number. If they confirm it is not them, apologise once and ask nothing more.';
    case LeadStatus.closed:
      return "This lead's file is closed. Answer politely, and offer to have someone from the team follow up if they need anything.";
    case LeadStatus.appointment_booked:
      return 'This lead already has a meeting booked with us. Never book another; for any change to it, say someone from the team will get back to them.';
    default:
      return '';
  }
}

/** The assistant's {{variables}} filled as Telnyx would; one without a value is left empty. Line breaks are kept. */
export function fillVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

export interface StoredText {
  direction: MessageDirection;
  senderType: MessageSender;
  body: string;
  senderUser?: { firstName: string | null; lastName: string | null; email: string } | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

const agentName = (u: NonNullable<StoredText['senderUser']>) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email;

/**
 * Texts further apart than this start a new conversation, as an assistant's
 * chat on Telnyx does after a quiet spell. What came before still reaches the
 * AI through the lead's memory (conversationSummary, knownInfo) and our last
 * text (last_outbound_sms), not as old turns it would take for the present: a
 * meeting booked last month read as "still on for Saturday".
 */
export const CONVERSATION_GAP_MS = 24 * 3_600_000;

/** Of the texts, newest first, those of the current conversation, oldest first. A text without a time is kept. */
export function currentConversation<T extends { createdAt?: Date | null }>(newestFirst: T[]): T[] {
  const kept: T[] = [];
  for (const text of newestFirst) {
    const newer = kept[kept.length - 1];
    if (newer?.createdAt && text.createdAt && newer.createdAt.getTime() - text.createdAt.getTime() > CONVERSATION_GAP_MS) break;
    kept.push(text);
  }
  return kept.reverse();
}

/**
 * The texts with the lead as the model reads them, oldest first: the lead's
 * as user turns, ours as assistant turns. A text an agent wrote is marked as
 * theirs, as in the Telnyx chat, so the AI never claims it.
 */
export function chatHistory(texts: StoredText[]): ChatMessage[] {
  return texts
    .filter((t) => t.body.trim())
    .map((t) => {
      if (t.direction === 'inbound') return { role: 'user' as const, content: t.body };
      const content = t.senderType === 'user' ? agentMessageForAi(t.senderUser ? agentName(t.senderUser) : 'Agent', t.body) : t.body;
      return { role: 'assistant' as const, content };
    });
}

/** The tools this server runs itself, by the names the assistant knows them. Any other (hangup, a custom webhook) is not offered in a text chat. */
export const AGENT_TOOLS = ['schedule_callback', 'schedule_text', 'record_outcome', 'check_availability', 'book_appointment'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
/** Tools that change something: once one ran in a turn, its reply is sent even if the lead texted again meanwhile. */
export const ACTING_TOOLS: AgentTool[] = ['schedule_callback', 'schedule_text', 'record_outcome', 'book_appointment'];

export interface FunctionTool {
  type: 'function';
  function: { name: AgentTool; description: string; parameters: Record<string, unknown> };
}

/**
 * The assistant's webhook tools as functions for the model, only those this
 * server runs: the same names, descriptions and parameters the call uses, so
 * the AI behaves the same in a text chat.
 */
export function toolFunctions(assistantTools: unknown[]): FunctionTool[] {
  const seen = new Set<string>();
  const out: FunctionTool[] = [];
  for (const raw of assistantTools ?? []) {
    const hook = (raw as { type?: string; webhook?: { name?: string; description?: string; body_parameters?: Record<string, unknown> } })?.webhook;
    const name = hook?.name as AgentTool | undefined;
    if ((raw as { type?: string })?.type !== 'webhook' || !name || !AGENT_TOOLS.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      type: 'function',
      function: { name, description: hook?.description ?? '', parameters: hook?.body_parameters ?? { type: 'object', properties: {} } },
    });
  }
  return out;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Typographic characters a model likes, as their GSM-7 forms: one em dash makes the whole text UCS-2, 70 characters a part instead of 160. */
const gsm = (text: string) =>
  text
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2009\u202F]/g, ' ');

/** At most this long: three texts of GSM-7. */
export const REPLY_MAX_CHARS = 459;

/**
 * The reply as it may be sent: links only where a tool gave them (a booking
 * confirmation), never one the lead or the model made up; no "[Agent …]"
 * prefix the model copied from the chat; and no longer than three texts, cut
 * at a sentence where it can be. Empty when nothing is left to send.
 */
export function guardReply(text: string, allowedLinks: string[] = []): string {
  // A reasoning model's thinking, if it returned any, is never for the lead.
  let reply = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const prefix = new RegExp(`^${AGENT_MESSAGE_PREFIX.replace(/[[\]]/g, '\\$&').replace('<name>', '[^\\]]*')}\\s*`);
  reply = reply.replace(prefix, '');
  // An email's domain is not a link: emails are set aside while links are taken out.
  const emails: string[] = [];
  reply = reply.replace(EMAIL, (email) => `\u0000${emails.push(email) - 1}\u0000`);
  for (const link of linksIn(reply)) {
    if (!allowedLinks.some((allowed) => allowed.includes(link) || link.includes(allowed))) reply = reply.split(link).join('');
  }
  reply = reply.replace(/\u0000(\d+)\u0000/g, (_, i: string) => emails[Number(i)]);
  reply = gsm(reply)
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim();
  if (reply.length <= REPLY_MAX_CHARS) return reply;
  const cut = reply.slice(0, REPLY_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > REPLY_MAX_CHARS / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, REPLY_MAX_CHARS - 3).trimEnd()}...`;
}

/** The links a tool's result carries (a meeting link), which the reply may repeat. */
export function linksFrom(results: unknown[]): string[] {
  return results.flatMap((r) => linksIn(JSON.stringify(r ?? '')));
}

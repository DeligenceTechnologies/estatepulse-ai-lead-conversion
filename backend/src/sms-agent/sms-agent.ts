import { LeadStatus, type MessageDirection, type MessageSender } from '@prisma/client';
import { linksIn } from '@/telnyx/lead-data';
import { AGENT_MESSAGE_PREFIX, agentMessageForAi } from '@/telnyx/sms/sms-prompt';

/**
 * The parts of this server's AI text replies that need no database or
 * network: who answers a text, the prompt, the chat as the model reads it,
 * the tools it may use, and the reply as it may be sent.
 */

/** Statuses whose texts the AI answers; at any other a person answers (user's decision, 2026-11-04). */
export const AI_ANSWERS: LeadStatus[] = [
  LeadStatus.new,
  LeadStatus.contacting,
  LeadStatus.engaged,
  LeadStatus.follow_up,
  LeadStatus.unresponsive,
  LeadStatus.interested,
  LeadStatus.appointment_requested,
];

/** On the lead's review flag while its text waits for a person. Cleared when an agent texts the lead. */
export const PERSON_REPLY_REVIEW = 'Texted us and needs a reply from a person: answer in Conversations';
/** On the review flag when the AI could not answer a text. */
export const AI_REPLY_FAILED_REVIEW = 'The AI could not answer a text: answer in Conversations';
/** On the review flag when the AI stopped answering a lead that texts without end (another bot, a loop). */
export const AI_REPLY_CAPPED_REVIEW = 'The AI stopped answering: too many texts in an hour. Answer in Conversations';

/**
 * Why a person, not the AI, answers this lead's text, or null when the AI
 * does. Judged on the lead as the text found it: an outcome the same text
 * leads to (a "no thanks") still gets the AI's one polite reply.
 */
export function personReason(lead: { status: LeadStatus; dncStatus: boolean; takenOverById: string | null }): string | null {
  if (lead.takenOverById) return 'an agent has taken the chat over';
  if (lead.dncStatus) return 'the lead opted out';
  if (!AI_ANSWERS.includes(lead.status)) return `the lead is ${lead.status.replace(/_/g, ' ')}`;
  return null;
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
  for (const link of linksIn(reply)) {
    if (!allowedLinks.some((allowed) => allowed.includes(link) || link.includes(allowed))) reply = reply.split(link).join('');
  }
  reply = reply.replace(/[ \t]+/g, ' ').replace(/ +([,.!?])/g, '$1').trim();
  if (reply.length <= REPLY_MAX_CHARS) return reply;
  const cut = reply.slice(0, REPLY_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > REPLY_MAX_CHARS / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, REPLY_MAX_CHARS - 3).trimEnd()}...`;
}

/** The links a tool's result carries (a meeting link), which the reply may repeat. */
export function linksFrom(results: unknown[]): string[] {
  return results.flatMap((r) => linksIn(JSON.stringify(r ?? '')));
}

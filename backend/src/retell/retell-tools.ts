import { callToolDefinitions } from '@/telnyx/tools/call-tools';
import type { RetellLlmTool } from './retell-api';

/** Where a Retell custom function is used: on a call (Retell sends the call in the body) or in a text chat (the chat id travels in the URL). */
export type RetellSession = 'call' | 'chat';

/** The tools this app puts on an organization's Retell LLMs; anything else on them is the organization's own. */
export const OUR_RETELL_TOOLS = new Set(['schedule_callback', 'record_outcome', 'check_availability', 'book_appointment']);
export const isOurRetellTool = (t: RetellLlmTool): boolean => typeof t?.name === 'string' && OUR_RETELL_TOOLS.has(t.name);

/**
 * `{{chat_id}}` is a Retell system variable in a chat session: appended to the
 * tool URL it identifies the chat on our side, since Retell documents the
 * request body only for calls.
 */
export const CHAT_ID_QUERY = 'chat_id={{chat_id}}';

/** The URL for one of our tools, as it must be on a Retell LLM for this server. */
export function retellToolUrl(apiUrl: string, path: string, session: RetellSession): string {
  return `${apiUrl}${path}${session === 'chat' ? `?${CHAT_ID_QUERY}` : ''}`;
}

/**
 * schedule_callback and record_outcome as Retell custom functions calling the
 * provider-neutral /tools/outcome URL, worded exactly as the Telnyx tools.
 * The bearer token lives only in the tool's headers on Retell; we keep its hash.
 */
export function retellOutcomeTools(apiUrl: string, token: string, session: RetellSession) {
  return callToolDefinitions('', '').map((t) => ({
    type: 'custom',
    name: t.webhook.name,
    description: t.webhook.description,
    url: retellToolUrl(apiUrl, `/tools/outcome/${t.webhook.url.split('/').at(-1)}`, session),
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    parameters: t.webhook.body_parameters,
    // Quick enough not to need a filler sentence; in a text chat a filler would be sent as an SMS.
    speak_during_execution: false,
    timeout_ms: t.timeout_ms,
  }));
}

/**
 * The same tools pointed at this server's address: a tool whose URL names
 * another host (an older tunnel, a previous domain) gets ours, keeping its
 * path, query and headers. Null when nothing needs changing.
 */
export function retargetOurTools(tools: RetellLlmTool[], apiUrl: string): RetellLlmTool[] | null {
  const origin = originOf(apiUrl);
  if (!origin) return null;
  let changed = false;
  const next = tools.map((t) => {
    if (!isOurRetellTool(t) || typeof t.url !== 'string') return t;
    const current = originOf(t.url);
    if (!current || current === origin) return t;
    const u = new URL(t.url);
    changed = true;
    return { ...t, url: `${apiUrl}${u.pathname}${u.search}` };
  });
  return changed ? next : null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

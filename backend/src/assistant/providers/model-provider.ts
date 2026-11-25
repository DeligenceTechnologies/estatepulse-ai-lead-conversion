/**
 * History is stored in one shape whichever provider wrote it: text, tool_use and
 * tool_result blocks (plus Claude's own blocks, such as thinking, which other
 * providers skip). Each provider converts to and from its wire format.
 */
export type StoredBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: StoredBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTurn {
  /** Stored as is and replayed on the next call. */
  content: StoredBlock[];
  toolCalls: ToolCall[];
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal';
  model: string;
  usage: TokenUsage;
}

export interface ModelRequest {
  system: string;
  tools: ToolSpec[];
  messages: StoredMessage[];
  onText: (delta: string) => void;
  signal: AbortSignal;
}

export interface ModelProvider {
  readonly name: 'claude' | 'openai';
  complete(request: ModelRequest): Promise<ModelTurn>;
  describe(error: unknown): { code: string; message: string } | null;
}

export const MODEL_PROVIDER = Symbol('MODEL_PROVIDER');

export const MAX_OUTPUT_TOKENS = 16_000;

export const BUSY = { code: 'ASSISTANT_BUSY', message: 'Copilot is busy right now. Try again in a minute.' };
export const UNAVAILABLE = { code: 'ASSISTANT_UNAVAILABLE', message: 'Copilot is unavailable right now. Try again shortly.' };

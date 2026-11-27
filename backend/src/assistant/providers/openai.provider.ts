import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  BUSY,
  MAX_OUTPUT_TOKENS,
  UNAVAILABLE,
  type ModelProvider,
  type ModelRequest,
  type ModelTurn,
  type StoredBlock,
  type StoredMessage,
  type ToolCall,
} from './model-provider';

const STOP: Record<string, ModelTurn['stop']> = {
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

const isText = (b: StoredBlock): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string';
const isToolUse = (b: StoredBlock): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use';
const isToolResult = (b: StoredBlock): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
  b.type === 'tool_result';

const parseArguments = (raw: string): unknown => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
};

/** Stored blocks to Chat Completions messages. Blocks only Claude understands (thinking and the like) are skipped. */
function toWire(system: string, messages: StoredMessage[]): ChatCompletionMessageParam[] {
  const wire: ChatCompletionMessageParam[] = [{ role: 'developer', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter(isText).map((b) => b.text).join('');
      const calls = m.content.filter(isToolUse);
      const message: ChatCompletionAssistantMessageParam = { role: 'assistant', content: text || null };
      if (calls.length > 0) {
        message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
      }
      wire.push(message);
      continue;
    }
    for (const r of m.content.filter(isToolResult)) {
      wire.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.is_error ? `Error: ${r.content}` : r.content });
    }
    const text = m.content.filter(isText).map((b) => b.text).join('\n\n');
    if (text) wire.push({ role: 'user', content: text });
  }
  return wire;
}

export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete({ system, tools, messages, onText, signal }: ModelRequest): Promise<ModelTurn> {
    const wireTools: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const stream = this.client.chat.completions.stream(
      {
        model: this.model,
        messages: toWire(system, messages),
        tools: wireTools.length > 0 ? wireTools : undefined,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        stream_options: { include_usage: true },
      },
      { signal },
    );
    stream.on('content', (delta) => onText(delta));
    const completion = await stream.finalChatCompletion();

    const choice = completion.choices[0];
    const message = choice?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
      .filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === 'function')
      .map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));

    const content: StoredBlock[] = [];
    if (message?.content) content.push({ type: 'text', text: message.content });
    for (const call of toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });

    const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      content,
      toolCalls,
      stop: message?.refusal ? 'refusal' : (STOP[choice?.finish_reason ?? ''] ?? 'end'),
      model: completion.model,
      usage: {
        inputTokens: (completion.usage?.prompt_tokens ?? 0) - cached,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }

  describe(error: unknown) {
    if (error instanceof OpenAI.RateLimitError) return BUSY;
    if (error instanceof OpenAI.APIConnectionError || (error instanceof OpenAI.APIError && (error.status ?? 0) >= 500)) return UNAVAILABLE;
    return null;
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { BUSY, MAX_OUTPUT_TOKENS, UNAVAILABLE, type ModelProvider, type ModelRequest, type ModelTurn, type StoredBlock } from './model-provider';

const STOP: Record<string, ModelTurn['stop']> = {
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

export class ClaudeProvider implements ModelProvider {
  readonly name = 'claude';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete({ system, tools, messages, onText, signal }: ModelRequest): Promise<ModelTurn> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        cache_control: { type: 'ephemeral' },
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool['input_schema'],
        })),
        messages: messages as unknown as Anthropic.Beta.BetaMessageParam[],
      },
      { signal },
    );
    stream.on('text', onText);
    const message = await stream.finalMessage();

    return {
      content: message.content as unknown as StoredBlock[],
      toolCalls: message.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stop: STOP[message.stop_reason ?? ''] ?? 'end',
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  describe(error: unknown) {
    if (error instanceof Anthropic.RateLimitError) return BUSY;
    if (error instanceof Anthropic.APIConnectionError || (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500)) return UNAVAILABLE;
    return null;
  }
}

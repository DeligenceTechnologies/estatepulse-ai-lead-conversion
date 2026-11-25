import type { ConfigService } from '@nestjs/config';
import { ClaudeProvider } from './providers/claude.provider';
import type { ModelProvider } from './providers/model-provider';
import { OpenAIProvider } from './providers/openai.provider';

export type AiProvider = 'claude' | 'openai';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export class AssistantConfig {
  private constructor(
    readonly enabled: boolean,
    readonly provider: AiProvider,
    readonly model: string,
    readonly apiKey: string | undefined,
    readonly reasoningEffort: ReasoningEffort | undefined,
  ) {}

  static fromConfigService(config: ConfigService): AssistantConfig {
    const provider = config.get<AiProvider>('AI_PROVIDER') ?? 'claude';
    return new AssistantConfig(
      config.get<boolean>('ASSISTANT_ENABLED') === true,
      provider,
      provider === 'openai' ? config.get<string>('OPENAI_MODEL')! : config.get<string>('ANTHROPIC_MODEL')!,
      (provider === 'openai' ? config.get<string>('OPENAI_API_KEY') : config.get<string>('ANTHROPIC_API_KEY')) || undefined,
      config.get<ReasoningEffort>('OPENAI_REASONING_EFFORT'),
    );
  }
}

export const createModelProvider = (config: AssistantConfig): ModelProvider | null => {
  if (!config.enabled || !config.apiKey) return null;
  return config.provider === 'openai' ? new OpenAIProvider(config.apiKey, config.model, config.reasoningEffort) : new ClaudeProvider(config.apiKey, config.model);
};

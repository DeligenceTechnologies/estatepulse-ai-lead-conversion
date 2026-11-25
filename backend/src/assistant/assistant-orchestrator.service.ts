import { Inject, Injectable, Logger } from '@nestjs/common';
import { AssistantRole } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { AssistantActionService } from './assistant-action.service';
import { SYSTEM_PROMPT } from './assistant.prompt';
import { AssistantThreadService, toActionView, type ActionView } from './assistant-thread.service';
import { AssistantUsageService } from './assistant-usage.service';
import { MODEL_PROVIDER, type ModelProvider, type ModelTurn } from './providers/model-provider';
import { ToolRegistry } from './tools/tool-registry.service';

/** Model calls per user request; a task needing more is stopped and the user asked to narrow it. */
const MAX_STEPS = 8;

export type AssistantEvent =
  | { type: 'thread'; threadId: string; title: string | null }
  | { type: 'text'; text: string }
  | { type: 'tool.started'; toolUseId: string; tool: string; label: string }
  | { type: 'tool.finished'; toolUseId: string; tool: string; ok: boolean }
  | { type: 'action'; action: ActionView }
  | { type: 'done'; awaitingConfirmation: boolean }
  | { type: 'error'; code: string; message: string };

export type Emit = (event: AssistantEvent) => void;

@Injectable()
export class AssistantOrchestrator {
  private readonly logger = new Logger(AssistantOrchestrator.name);

  constructor(
    @Inject(MODEL_PROVIDER) private readonly provider: ModelProvider | null,
    private readonly registry: ToolRegistry,
    private readonly threads: AssistantThreadService,
    private readonly actions: AssistantActionService,
    private readonly usage: AssistantUsageService,
  ) {}

  /** Runs model and tools until the model answers, a write needs confirming, or the step limit is reached. */
  async run(auth: AuthContext, threadId: string, emit: Emit, signal: AbortSignal): Promise<void> {
    const provider = this.provider;
    if (!provider) throw new AppError('ASSISTANT_DISABLED', 'Copilot is not switched on for this server.', undefined, 503);
    const orgId = auth.organizationId;
    const tools = this.registry.definitionsFor(auth);

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return;
      await this.usage.assertWithinBudget(orgId);

      let turn: ModelTurn;
      try {
        turn = await provider.complete({
          system: SYSTEM_PROMPT,
          tools,
          messages: await this.threads.history(orgId, threadId),
          onText: (text) => emit({ type: 'text', text }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }

      await this.usage.record(orgId, turn.model, turn.usage);
      const saved = await this.threads.append(orgId, threadId, {
        role: AssistantRole.assistant,
        content: turn.content,
        model: turn.model,
        usage: turn.usage,
        stopReason: turn.stop,
      });

      if (turn.stop === 'refusal') {
        emit({ type: 'error', code: 'ASSISTANT_DECLINED', message: "Copilot can't help with that request." });
        return emit({ type: 'done', awaitingConfirmation: false });
      }

      const calls = turn.toolCalls;
      if (calls.length === 0) return emit({ type: 'done', awaitingConfirmation: false });

      let awaiting = false;
      for (const call of calls) {
        const tool = this.registry.get(call.name);
        emit({ type: 'tool.started', toolUseId: call.id, tool: call.name, label: tool?.label ?? 'Working' });
        const action = await this.actions.handle(auth, threadId, saved.id, call);
        emit({ type: 'tool.finished', toolUseId: call.id, tool: call.name, ok: action.status !== 'failed' });
        if (action.tier === 'write') emit({ type: 'action', action: toActionView(action) });
        if (action.status === 'proposed') awaiting = true;
      }
      if (awaiting) return emit({ type: 'done', awaitingConfirmation: true });

      await this.actions.closeOpenCalls(auth, threadId, false);
    }

    emit({ type: 'error', code: 'ASSISTANT_STEP_LIMIT', message: 'That took too many steps. Try asking for one thing at a time.' });
    emit({ type: 'done', awaitingConfirmation: false });
  }

  /** Turns a failure into something the dock can show; the details stay in the server log. */
  describe(error: unknown): { code: string; message: string } {
    if (error instanceof AppError) return { code: String(error.code), message: error.message };
    const known = this.provider?.describe(error);
    if (known) return known;
    this.logger.error(`turn failed: ${(error as Error)?.stack ?? String(error)}`);
    return { code: 'INTERNAL', message: 'Copilot hit an unexpected error. Try again.' };
  }
}

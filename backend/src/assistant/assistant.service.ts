import { AssistantSettingsService } from './assistant-settings.service';
import { Injectable } from '@nestjs/common';
import { AssistantRole } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { Feature } from '@/billing/billing-plans';
import { EntitlementService } from '@/billing/entitlements/entitlement.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { fullName } from '@/lead/lead-scope';
import { AssistantActionService } from './assistant-action.service';
import { AssistantLimitsService, type TurnAbortReason } from './assistant-limits.service';
import { AssistantOrchestrator, type Emit } from './assistant-orchestrator.service';
import { AssistantRefService } from './assistant-ref.service';
import { AssistantConfig } from './assistant.config';
import { contextBlock } from './assistant.prompt';
import { AssistantThreadService, MAX_THREAD_MESSAGES, toActionView } from './assistant-thread.service';
import { AssistantUsageService } from './assistant-usage.service';
import type { SendMessageDto } from './dto/send-message.dto';
import type { EventStream } from './event-stream';
import { refOf } from './tools/refs';

/** Room left for the model's steps after the user's message. */
const TURN_HEADROOM = 20;

/**
 * The three ways a turn starts: a new message, a confirmation, a decline.
 * Checks that can fail run before the stream opens, so they answer as ordinary JSON errors.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly config: AssistantConfig,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly limits: AssistantLimitsService,
    private readonly usage: AssistantUsageService,
    private readonly threads: AssistantThreadService,
    private readonly actions: AssistantActionService,
    private readonly orchestrator: AssistantOrchestrator,
    private readonly refs: AssistantRefService,
    private readonly settings: AssistantSettingsService,
  ) {}

  async status(auth: AuthContext) {
    const [entitlements, settings, usage] = await Promise.all([
      this.entitlements.get(auth.organizationId),
      this.settings.get(auth.organizationId),
      this.usage.summary(auth.organizationId),
    ]);
    return {
      // On for this server and for this office.
      enabled: this.config.enabled && settings.enabled,
      officeEnabled: settings.enabled,
      voiceEnabled: settings.voiceEnabled,
      included: !entitlements.enforced || entitlements.features.includes(Feature.AI_ASSISTANT),
      usage,
    };
  }

  async send(auth: AuthContext, input: SendMessageDto, stream: EventStream): Promise<void> {
    await this.admit(auth);
    const thread = input.threadId ? await this.threads.require(auth, input.threadId) : await this.threads.create(auth, input.text);
    if (thread.messageCount >= MAX_THREAD_MESSAGES - TURN_HEADROOM) {
      throw new AppError('ASSISTANT_THREAD_FULL', 'This chat is full. Start a new chat to continue.', undefined, 409);
    }

    const lock = await this.limits.lockThread(thread.id);
    const turn = await this.limits.turnSignal(thread.id);
    try {
      await this.actions.closeOpenCalls(auth, thread.id, true);
      if (await this.actions.awaitingResults(auth.organizationId, thread.id)) {
        throw new AppError('ASSISTANT_BUSY', 'The last step in this chat is still finishing. Try again in a minute.', undefined, 409);
      }
      const user = await this.prisma.user.findFirst({
        where: { id: auth.userId, orgId: auth.organizationId },
        select: { firstName: true, lastName: true, email: true, timezone: true },
      });
      const context = contextBlock({
        now: new Date(),
        // The user's own ref, so "give it to me" needs no look-up.
        userRef: await refOf(this.refs.forThread(auth, thread.id), 'user', auth.userId),
        userName: fullName(user?.firstName, user?.lastName, user?.email ?? 'User'),
        timezone: user?.timezone ?? null,
        screen: input.screen,
      });
      await this.threads.append(auth.organizationId, thread.id, {
        role: AssistantRole.user,
        content: [
          { type: 'text', text: context },
          { type: 'text', text: input.text },
        ],
        text: input.text,
      });
      stream.send({ type: 'thread', threadId: thread.id, title: thread.title });
      await this.orchestrator.run(auth, thread.id, stream.send, turn.signal);
      endIfCut(turn.signal, stream.send);
    } finally {
      turn.dispose();
      await lock.release();
    }
  }

  async decide(auth: AuthContext, actionId: string, decision: 'confirm' | 'reject', stream: EventStream): Promise<void> {
    await this.admit(auth);
    const pending = await this.actions.require(auth, actionId);

    const lock = await this.limits.lockThread(pending.threadId);
    const turn = await this.limits.turnSignal(pending.threadId);
    try {
      const action = decision === 'confirm' ? await this.actions.confirm(auth, actionId) : await this.actions.reject(auth, actionId);
      stream.send({ type: 'action', action: toActionView(action) });

      if (!(await this.actions.settled(auth.organizationId, action.messageId))) {
        return stream.send({ type: 'done', awaitingConfirmation: true });
      }
      if (await this.actions.closeOpenCalls(auth, action.threadId, false)) {
        await this.orchestrator.run(auth, action.threadId, stream.send, turn.signal);
        endIfCut(turn.signal, stream.send);
      } else {
        stream.send({ type: 'done', awaitingConfirmation: false });
      }
    } finally {
      turn.dispose();
      await lock.release();
    }
  }

  /** Stops the turn running in one of the user's chats, after the step it is on. A write already confirmed still finishes. */
  async stop(auth: AuthContext, threadId: string): Promise<void> {
    await this.threads.require(auth, threadId);
    await this.limits.requestStop(threadId);
  }

  private async admit(auth: AuthContext): Promise<void> {
    if (!this.config.enabled) throw new AppError('ASSISTANT_DISABLED', 'The assistant is not switched on for this server.', undefined, 503);
    if (!(await this.settings.get(auth.organizationId)).enabled) {
      throw new AppError('ASSISTANT_OFF_FOR_OFFICE', 'Your office has turned the assistant off. An owner can turn it on in Settings > Ask EstatePulse.', undefined, 403);
    }
    await this.entitlements.assertFeature(auth.organizationId, Feature.AI_ASSISTANT);
    await this.limits.consume(auth.userId);
    await this.usage.assertWithinBudget(auth.organizationId);
  }
}

/** A turn cut by Stop or by the time limit ends quietly in the orchestrator; this closes the stream for the user. */
function endIfCut(signal: AbortSignal, emit: Emit): void {
  if (!signal.aborted) return;
  if ((signal.reason as TurnAbortReason) === 'timeout') {
    emit({ type: 'error', code: 'ASSISTANT_TIMEOUT', message: 'That took too long. Try asking for one thing at a time.' });
  }
  emit({ type: 'done', awaitingConfirmation: false });
}

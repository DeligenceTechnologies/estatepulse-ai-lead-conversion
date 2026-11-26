import { Inject, Injectable } from '@nestjs/common';
import { AssistantRole, Prisma, type AssistantAction, type AssistantRating } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import type { StoredBlock, StoredMessage, TokenUsage } from './providers/model-provider';
import { AssistantRefService } from './assistant-ref.service';
import type { ActionPreview } from './tools/tool';

/** Long enough for real work; past it a fresh chat is cheaper and sharper than replaying everything. */
export const MAX_THREAD_MESSAGES = 200;
const LIST_LIMIT = 30;
const TITLE_CHARS = 80;

export interface AppendInput {
  role: AssistantRole;
  content: StoredBlock[];
  text?: string;
  model?: string;
  usage?: TokenUsage;
  stopReason?: string | null;
}

export interface ActionView {
  id: string;
  messageId: string;
  tool: string;
  status: AssistantAction['status'];
  title: string;
  summary: string | null;
  changes: ActionPreview['changes'];
  error: string | null;
  expiresAt: Date | null;
  decidedAt: Date | null;
  /** A bulk card: how many leads, a few names, what was left out; `status` is its job's, once approved. */
  bulk?: { total: number; status: string | null; sample?: string[]; skipped?: Record<string, number> };
}

export const FEEDBACK_REASONS = ['wrong', 'not_done', 'unclear', 'other'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** A person's thumbs up or down on one answer; a reason and comment only come with a thumbs down. */
export interface FeedbackView {
  rating: AssistantRating;
  reason: FeedbackReason | null;
  comment: string | null;
}

export interface MessageView {
  id: string;
  role: AssistantRole;
  text: string;
  createdAt: Date;
  actions: ActionView[];
  /** On an answer the person rated. */
  feedback?: FeedbackView;
}

export const toActionView = (a: AssistantAction): ActionView => {
  const preview = (a.preview ?? null) as Partial<ActionPreview> | null;
  return {
    id: a.id,
    messageId: a.messageId,
    tool: a.toolName,
    status: a.status,
    title: preview?.title ?? a.toolName,
    summary: preview?.summary ?? null,
    changes: preview?.changes ?? [],
    error: a.error,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt,
    ...(a.bulkTotal !== null
      ? { bulk: { total: a.bulkTotal, status: a.bulkStatus, ...((preview as { bulk?: { sample?: string[]; skipped?: Record<string, number> } } | null)?.bulk ?? {}) } }
      : {}),
  };
};

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    : '';

@Injectable()
export class AssistantThreadService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly refs: AssistantRefService,
  ) {}

  create(auth: AuthContext, firstMessage: string) {
    const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
    return this.prisma.assistantThread.create({
      data: { orgId: auth.organizationId, userId: auth.userId, title },
      select: { id: true, title: true, messageCount: true },
    });
  }

  list(auth: AuthContext) {
    return this.prisma.assistantThread.findMany({
      where: { orgId: auth.organizationId, userId: auth.userId },
      orderBy: { lastMessageAt: 'desc' },
      take: LIST_LIMIT,
      select: { id: true, title: true, lastMessageAt: true, createdAt: true },
    });
  }

  /** Threads are private to the user who started them. */
  async require(auth: AuthContext, threadId: string) {
    const thread = await this.prisma.assistantThread.findFirst({
      where: { id: threadId, orgId: auth.organizationId, userId: auth.userId },
      select: { id: true, title: true, messageCount: true, lastMessageAt: true, createdAt: true },
    });
    if (!thread) throw new AppError('NOT_FOUND', 'No such chat.');
    return thread;
  }

  /**
   * Rates one answer in the person's own chat: up, down (with an optional reason and comment), or
   * null to take the rating back. Saying it again replaces it.
   */
  async rate(
    auth: AuthContext,
    messageId: string,
    input: { rating?: AssistantRating | null; reason?: FeedbackReason | null; comment?: string | null },
  ): Promise<FeedbackView | null> {
    const message = await this.prisma.assistantMessage.findFirst({ where: { id: messageId, role: AssistantRole.assistant }, select: { threadId: true } });
    if (!message) throw new AppError('NOT_FOUND', 'No such answer.');
    await this.require(auth, message.threadId);
    if (!input.rating) {
      await this.prisma.assistantFeedback.deleteMany({ where: { messageId } });
      return null;
    }
    const down = input.rating === 'down';
    const data = { rating: input.rating, reason: down ? (input.reason ?? null) : null, comment: down ? input.comment?.trim() || null : null };
    const row = await this.prisma.assistantFeedback.upsert({
      where: { messageId },
      create: { orgId: auth.organizationId, threadId: message.threadId, messageId, ...data },
      update: data,
    });
    return { rating: row.rating, reason: row.reason as FeedbackReason | null, comment: row.comment };
  }

  async remove(auth: AuthContext, threadId: string): Promise<void> {
    await this.require(auth, threadId);
    await this.prisma.assistantThread.deleteMany({ where: { id: threadId, orgId: auth.organizationId, userId: auth.userId } });
  }

  async view(auth: AuthContext, threadId: string) {
    const thread = await this.require(auth, threadId);
    const [messages, actions, ratings] = await Promise.all([
      this.prisma.assistantMessage.findMany({
        where: { orgId: auth.organizationId, threadId },
        orderBy: { position: 'asc' },
        select: { id: true, role: true, content: true, text: true, createdAt: true },
      }),
      this.prisma.assistantAction.findMany({
        where: { orgId: auth.organizationId, threadId, tier: 'write' },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.assistantFeedback.findMany({ where: { threadId }, select: { messageId: true, rating: true, reason: true, comment: true } }),
    ]);
    const feedback = new Map(ratings.map((r) => [r.messageId, { rating: r.rating, reason: r.reason as FeedbackReason | null, comment: r.comment }]));
    const byMessage = new Map<string, ActionView[]>();
    for (const a of actions) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), toActionView(a)]);

    const views: MessageView[] = [];
    for (const m of messages) {
      const text = m.role === AssistantRole.user ? (m.text ?? '') : textOf(m.content);
      const own = byMessage.get(m.id) ?? [];
      if (!text && own.length === 0) continue;
      const rated = feedback.get(m.id);
      views.push({ id: m.id, role: m.role, text, createdAt: m.createdAt, actions: own, ...(rated ? { feedback: rated } : {}) });
    }
    // Links for the leads the answers name; looked up now, so a lead the user can no longer see has none.
    const { links } = await this.refs.inspect(auth, threadId, views.filter((v) => v.role === AssistantRole.assistant).map((v) => v.text));
    return { thread, messages: views, refs: links };
  }

  async history(orgId: string, threadId: string): Promise<StoredMessage[]> {
    const rows = await this.prisma.assistantMessage.findMany({
      where: { orgId, threadId },
      orderBy: { position: 'asc' },
      select: { role: true, content: true },
    });
    return rows.map((r) => ({ role: r.role, content: r.content as unknown as StoredBlock[] }));
  }

  async lastMessage(orgId: string, threadId: string) {
    return this.prisma.assistantMessage.findFirst({
      where: { orgId, threadId },
      orderBy: { position: 'desc' },
      select: { id: true, role: true, content: true },
    });
  }

  /** Appends at the next position. History is append-only: replayed turns must stay byte-for-byte what was sent. */
  async append(orgId: string, threadId: string, input: AppendInput) {
    return this.prisma.$transaction(async (tx) => {
      const thread = await tx.assistantThread.update({
        where: { id: threadId, orgId },
        data: { messageCount: { increment: 1 }, lastMessageAt: new Date() },
        select: { messageCount: true },
      });
      if (thread.messageCount > MAX_THREAD_MESSAGES) {
        throw new AppError('ASSISTANT_THREAD_FULL', 'This chat is full. Start a new chat to continue.', undefined, 409);
      }
      return tx.assistantMessage.create({
        data: {
          orgId,
          threadId,
          position: thread.messageCount - 1,
          role: input.role,
          content: input.content as unknown as Prisma.InputJsonValue,
          text: input.text,
          model: input.model,
          inputTokens: input.usage ? input.usage.inputTokens + input.usage.cacheWriteTokens : 0,
          outputTokens: input.usage?.outputTokens ?? 0,
          cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
          stopReason: input.stopReason ?? null,
        },
        select: { id: true },
      });
    });
  }
}

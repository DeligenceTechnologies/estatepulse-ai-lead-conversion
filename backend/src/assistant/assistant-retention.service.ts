import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

/** Chats are deleted this many days after their last message. */
export const CHAT_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
/** Four times a day; the first a minute after the server starts. */
const SWEEP_MS = 6 * 60 * 60_000;
const FIRST_SWEEP_MS = 60_000;
/** Chats deleted per statement, so a large backlog never holds a long lock. */
const BATCH = 200;

/**
 * Deletes chats whose last message is over CHAT_RETENTION_DAYS old, with everything in them:
 * messages, cards and their leads, refs and ratings (all cascade from the chat). A chat whose bulk
 * job is still running waits until the job ends. What the assistant changed stays in the audit
 * log, which keeps its own rows. Runs across every office (no tenant context), and twice at once
 * is harmless: a chat is deleted once.
 */
@Injectable()
export class AssistantRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AssistantRetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.first = setTimeout(() => void this.sweep(), FIRST_SWEEP_MS);
    this.first.unref?.();
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** Deletes the chats past the retention period and returns how many. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const before = new Date(now.getTime() - CHAT_RETENTION_DAYS * DAY_MS);
    const expired = { lastMessageAt: { lt: before }, actions: { none: { bulkStatus: { in: ['queued', 'running'] } } } };
    let deleted = 0;
    try {
      for (;;) {
        const batch = await this.prisma.assistantThread.findMany({ where: expired, orderBy: { lastMessageAt: 'asc' }, take: BATCH, select: { id: true } });
        if (batch.length === 0) break;
        const { count } = await this.prisma.assistantThread.deleteMany({ where: { id: { in: batch.map((t) => t.id) }, ...expired } });
        deleted += count;
        if (count === 0 || batch.length < BATCH) break;
      }
      if (deleted) this.logger.log(`deleted ${deleted} chat(s) with no message for ${CHAT_RETENTION_DAYS} days`);
    } catch (error) {
      this.logger.error(`chat retention: ${(error as Error)?.message ?? String(error)}`);
    } finally {
      this.running = false;
    }
    return deleted;
  }
}

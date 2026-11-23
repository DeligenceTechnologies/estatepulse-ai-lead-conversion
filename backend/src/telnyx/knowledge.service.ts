import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import {
  BODY_MAX_CHARS,
  MAX_ENTRIES,
  TITLE_MAX_CHARS,
  TOTAL_MAX_CHARS,
  knowledgeEntries,
  knowledgeSize,
  type KnowledgeEntry,
} from './knowledge';

export interface KnowledgeLimits {
  maxEntries: number;
  titleMaxChars: number;
  bodyMaxChars: number;
  totalMaxChars: number;
}

export interface KnowledgeStatus {
  entries: KnowledgeEntry[];
  /** What the entries cost against totalMaxChars, so the editor can show the budget. */
  size: number;
  limits: KnowledgeLimits;
}

export const KNOWLEDGE_LIMITS: KnowledgeLimits = {
  maxEntries: MAX_ENTRIES,
  titleMaxChars: TITLE_MAX_CHARS,
  bodyMaxChars: BODY_MAX_CHARS,
  totalMaxChars: TOTAL_MAX_CHARS,
};

/**
 * The organization's knowledge base. Every method takes the organization from
 * its caller's credential; nothing here reads an id out of a request body.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string): Promise<KnowledgeEntry[]> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { knowledge: true } });
    return knowledgeEntries(row?.knowledge ?? null);
  }

  async status(orgId: string): Promise<KnowledgeStatus> {
    const entries = await this.get(orgId);
    return { entries, size: knowledgeSize(entries), limits: KNOWLEDGE_LIMITS };
  }

  /**
   * Replaces the whole list in one statement, so there is no read-then-write
   * window and no partial merge. An empty list is stored as NULL, so "cleared"
   * and "never set" are one state.
   *
   * ponytail: last write wins. Two owners editing at the same time means the
   * earlier one's new fact is silently dropped. Acceptable while this is an
   * owner-only settings page edited rarely; if it bites, send the `updatedAt`
   * the editor loaded and reject the save when it has moved.
   */
  async set(orgId: string, input: unknown): Promise<KnowledgeStatus> {
    const entries = knowledgeEntries(input);
    // The DTO has already capped each entry and the count, so the only way the
    // normalizer can still drop one is the whole-list budget. Say so, rather
    // than silently saving less than the owner typed.
    if (Array.isArray(input) && entries.length < input.length) {
      throw new AppError(
        'VALIDATION_ERROR',
        `That is more knowledge than the AI can carry on a call. Keep the titles and answers together under ${TOTAL_MAX_CHARS} characters.`,
      );
    }
    const data = { knowledge: (entries.length ? entries : null) as unknown as Prisma.InputJsonValue };
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
    return { entries, size: knowledgeSize(entries), limits: KNOWLEDGE_LIMITS };
  }
}

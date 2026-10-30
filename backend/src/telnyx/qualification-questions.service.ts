import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import {
  coerceAnswer,
  normalizeQuestions,
  questionStatus,
  storedAnswers,
  type LeadMemoryFields,
  type Question,
  type QuestionStatus,
} from './qualification';

export const LEAD_MEMORY_FIELDS = {
  timeline: true,
  location: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
  financingStatus: true,
  motivation: true,
  qualificationAnswers: true,
} satisfies Prisma.LeadSelect;

/** What the AI knows about a lead: each question with its answer, and the notes no question covers. */
export interface LeadMemory {
  questions: QuestionStatus[];
  summary: string | null;
  summaryAt: string | null;
}

/** An org's qualification questions, and each lead's answers to them. */
@Injectable()
export class QualificationQuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string): Promise<Question[]> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { qualificationQuestions: true } });
    return normalizeQuestions(s?.qualificationQuestions ?? null);
  }

  async set(orgId: string, input: unknown[]): Promise<Question[]> {
    const questions = normalizeQuestions(input);
    const data = { qualificationQuestions: questions as unknown as Prisma.InputJsonArray };
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
    return questions;
  }

  async forLead(orgId: string, leadId: string): Promise<LeadMemory> {
    const [questions, lead] = await Promise.all([
      this.get(orgId),
      this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { ...LEAD_MEMORY_FIELDS, memorySummary: true, memoryUpdatedAt: true } }),
    ]);
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead');
    return {
      questions: questionStatus(questions, lead as LeadMemoryFields),
      summary: lead.memorySummary,
      summaryAt: lead.memoryUpdatedAt?.toISOString() ?? null,
    };
  }

  /** A person's edit of one custom answer; null clears it so the assistant asks again. */
  async setAnswer(orgId: string, leadId: string, key: string, value: unknown): Promise<LeadMemory> {
    const questions = await this.get(orgId);
    const q = questions.find((x) => x.key === key && !x.builtin);
    if (!q) throw new AppError('NOT_FOUND', 'No such custom question');
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { qualificationAnswers: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead');

    if (value != null && typeof value === 'object') throw new AppError('VALIDATION_ERROR', 'An answer is text, a number or yes/no');
    const answers = storedAnswers(lead.qualificationAnswers);
    if (value == null || value === '') {
      delete answers[key];
    } else {
      const coerced = coerceAnswer(q, value);
      if (coerced == null) throw new AppError('VALIDATION_ERROR', `Not a valid answer for "${q.label}"`);
      answers[key] = { value: coerced, at: new Date().toISOString(), source: 'manual' };
    }
    await this.prisma.lead.update({ where: { id: leadId }, data: { qualificationAnswers: answers as unknown as Prisma.InputJsonObject } });
    return this.forLead(orgId, leadId);
  }
}

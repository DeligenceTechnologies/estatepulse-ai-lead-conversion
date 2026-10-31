import { Injectable, Logger } from '@nestjs/common';
import type { Call, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { LeadInsightsService } from './lead-insights.service';
import { leadDetailsFrom, type Extraction } from './lead-scoring';
import { mergeAnswers, storedAnswers } from './qualification';
import { QualificationQuestionsService } from './qualification-questions.service';

/** A text chat is read once it has been quiet this long, not on every message. */
export const CHAT_QUIET_MS = 2 * 60_000;
/** How many of the lead's latest texts a chat read covers. */
const CHAT_WINDOW = 30;

/**
 * What a lead told us, kept across calls and text chats: the answers to the
 * org's questions and a short note of everything else. Every call and chat
 * reads it (see ActivityService.leadVariables), so nothing is asked twice.
 */
@Injectable()
export class LeadMemoryService {
  private readonly logger = new Logger(LeadMemoryService.name);
  private readonly chatTimers = new Map<string, NodeJS.Timeout>();
  /** One memory update per lead at a time: a call and a chat ending together must not overwrite each other. */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly insights: LeadInsightsService,
    private readonly questions: QualificationQuestionsService,
  ) {}

  /** After a scored call that reached the lead: its answers, and the note rewritten with the call. */
  afterCall(call: Call, extraction: Extraction): Promise<void> {
    return this.serial(call.leadId, async () => {
      await this.saveAnswers(call.orgId, call.leadId, extraction.answers, call.createdAt, 'call', call.id);
      const conversation = call.transcript?.trim() || extraction.summary;
      await this.rewriteNote(call.orgId, call.leadId, conversation);
    }).catch((error) => this.logger.warn(`memory after call ${call.id}: ${(error as Error).message}`));
  }

  /** A lead texted: the chat is read once it goes quiet. A newer text restarts the wait. */
  onLeadText(orgId: string, leadId: string, delayMs = CHAT_QUIET_MS): void {
    clearTimeout(this.chatTimers.get(leadId));
    const timer = setTimeout(() => {
      this.chatTimers.delete(leadId);
      void this.serial(leadId, () => this.readChat(orgId, leadId)).catch((error) =>
        this.logger.warn(`memory from texts of lead ${leadId}: ${(error as Error).message}`),
      );
    }, delayMs);
    timer.unref();
    this.chatTimers.set(leadId, timer);
  }

  /** The texts since the memory was last updated, read into the lead's details, answers and note. */
  async readChat(orgId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { memoryUpdatedAt: true } });
    if (!lead) return;
    const texts = await this.prisma.message.findMany({
      where: { orgId, leadId, channel: 'sms' },
      orderBy: { createdAt: 'desc' },
      take: CHAT_WINDOW,
      select: { id: true, direction: true, body: true, createdAt: true },
    });
    const since = lead.memoryUpdatedAt?.getTime() ?? 0;
    const newFromLead = texts.filter((m) => m.direction === 'inbound' && m.createdAt.getTime() > since);
    if (!newFromLead.length) return;

    const chat = texts
      .slice()
      .reverse()
      .map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Us'}: ${m.body ?? ''}`)
      .join('\n');
    const extraction = await this.insights.extractFromChat(orgId, chat);
    const details = leadDetailsFrom(extraction);
    if (Object.keys(details).length) await this.prisma.lead.update({ where: { id: leadId }, data: details });
    const latest = newFromLead[0];
    await this.saveAnswers(orgId, leadId, extraction.answers, latest.createdAt, 'sms', latest.id);

    // The note only needs the texts it has not seen, with a little context before them.
    const fresh = texts.filter((m) => m.createdAt.getTime() > since);
    const context = texts.slice(fresh.length, fresh.length + 4);
    const recent = [...fresh, ...context]
      .reverse()
      .map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Us'}: ${m.body ?? ''}`)
      .join('\n');
    await this.rewriteNote(orgId, leadId, `Text chat:\n${recent}`);
  }

  private async saveAnswers(
    orgId: string,
    leadId: string,
    extracted: Extraction['answers'],
    at: Date,
    source: 'call' | 'sms',
    refId: string,
  ): Promise<void> {
    if (!extracted) return;
    const [questions, lead] = await Promise.all([
      this.questions.get(orgId),
      this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { qualificationAnswers: true } }),
    ]);
    if (!lead) return;
    const { answers, changed } = mergeAnswers(storedAnswers(lead.qualificationAnswers), extracted, questions, at, source, refId);
    if (!changed) return;
    await this.prisma.lead.update({ where: { id: leadId }, data: { qualificationAnswers: answers as unknown as Prisma.InputJsonObject } });
  }

  private async rewriteNote(orgId: string, leadId: string, conversation: string): Promise<void> {
    if (!conversation.trim()) return;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId }, select: { memorySummary: true } });
    if (!lead) return;
    const note = await this.insights.rewriteMemory(orgId, lead.memorySummary, conversation);
    await this.prisma.lead.update({ where: { id: leadId }, data: { memorySummary: note || null, memoryUpdatedAt: new Date() } });
  }

  private serial(leadId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.queue.get(leadId) ?? Promise.resolve()).catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.queue.set(leadId, tail);
    void tail.then(() => {
      if (this.queue.get(leadId) === tail) this.queue.delete(leadId);
    });
    return run;
  }
}

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallDisposition, CallStatus } from '@prisma/client';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { QueueEnv } from '@/common/utils/interface';
import { leadZone } from '@/common/utils/lead-timezone';
import { TZ_RECHECK_MS, gateLine, nextLeadContactAt } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { hasUpcomingMeeting } from '@/lead/upcoming-meeting';
import { TEXT_QUEUE, TextJob } from '@/queue/queue.constants';
import { ActivityService } from '../activity.service';
import { SmsService } from '../sms.service';
import { SmsConversationService } from '../sms/sms-conversation.service';
import { fillTemplate } from '../template';
import { CallToolsService } from './call-tools.service';
import { TEXT_BACK_BLOCKED, type TextBackJobData } from './text-back.service';

/** How often a text asked for on a call looks again while that call's answers are still being saved. */
const MEMORY_RECHECK_MS = 15_000;
/** The longest it waits for them after the call ends: a call whose insights never come does not hold the text forever. */
const MEMORY_WAIT_MAX_MS = 3 * 60_000;

/**
 * Sends the text a lead asked for, at their time: the organization's message,
 * added to the AI's text conversation so the lead's answer continues the chat.
 * Runs on the instance that runs the call worker (CALL_WORKER_ENABLED).
 */
@Processor(TEXT_QUEUE, { autorun: false })
export class TextBackWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(TextBackWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<QueueEnv, true>,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly state: LeadStateService,
    private readonly tools: CallToolsService,
    private readonly sms: SmsService,
    private readonly activity: ActivityService,
    private readonly conversations: SmsConversationService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('CALL_WORKER_ENABLED', { infer: true })) {
      this.logger.log('Text-back worker is off on this instance (CALL_WORKER_ENABLED=false)');
      return;
    }
    void this.worker.run().catch((error) => this.logger.error(`Text-back worker stopped: ${(error as Error).message}`));
    this.logger.log('Text-back worker started');
  }

  async process(job: Job<TextBackJobData>, token?: string): Promise<void> {
    if (job.name !== TextJob.TextBack) throw new UnrecoverableError(`Unknown text job "${job.name}"`);
    const { orgId, leadId, at } = job.data;
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { phone: true, normalizedPhone: true, timezone: true, status: true, dncStatus: true, textBackAt: true },
    });
    if (!lead || lead.textBackAt?.toISOString() !== at) {
      this.logger.log(`Text back for lead ${leadId} at ${at} dropped: it was moved or cancelled since`);
      return;
    }
    // The job can run before its time: setting the lead's zone promotes every delayed job they have.
    // The hour the lead asked for is theirs, so it waits for it again.
    const due = Date.parse(at);
    if (due > Date.now()) {
      this.logger.log(`Text back for lead ${leadId} is not due until ${at}: waiting`);
      await job.moveToDelayed(due, token);
      throw new DelayedError();
    }
    const drop = async (reason: string) => {
      await this.clear(leadId, at);
      this.state.quietly({ orgId, leadId, type: 'text_back_dropped', source: 'text_back', channel: 'sms', reason });
      this.logger.log(`Text back for lead ${leadId} dropped: ${reason}`);
    };
    if (lead.dncStatus) return drop('The lead opted out');
    // Paused automation is not a reason: the lead asked for this text (the AI promised it), and paused only stops
    // outreach. A chat an agent takes over clears textBackAt, so the agent is never talked over.
    if (TEXT_BACK_BLOCKED.includes(lead.status)) return drop(`The lead is ${lead.status}`);
    if (!lead.phone) return drop('The lead has no phone number');
    if (await hasUpcomingMeeting(this.prisma, orgId, leadId)) return drop('A meeting with the lead is on the calendar');

    // The time was checked when it was set; a delay, or a zone set since, can still put it outside the
    // lead's hours. Measured on the LEAD's clock: quiet hours and their jurisdiction's legal hours (a text
    // they asked for ignores the organization's days off). No zone, no text: looked at again every hour.
    const { quiet } = await this.followup.guardrailsFor(orgId);
    const zone = leadZone(lead);
    const window = nextLeadContactAt(zone, { quiet, skipDays: [] }, new Date(), { callback: true });
    if (!window.allowedAt) {
      const first = await this.followup.holdOnce(orgId, leadId, `Text held — ${window.reason}`, 'text_back', 'sms');
      this.logger[first ? 'log' : 'debug'](gateLine(orgId, leadId, zone, window, 'held'));
      await job.moveToDelayed(Date.now() + TZ_RECHECK_MS, token);
      throw new DelayedError();
    }
    if (window.allowedAt.getTime() > Date.now()) {
      this.logger.log(gateLine(orgId, leadId, zone, window, 'deferred'));
      await job.moveToDelayed(window.allowedAt.getTime(), token);
      throw new DelayedError();
    }

    // Asked for on a call ("let's continue on text"): the answers from that call are saved once Telnyx's
    // insights arrive, a little after it ends. The text waits for them, so {{nextQuestion}} and the chat
    // that follows know what the lead already said.
    if (await this.callAnswersPending(leadId)) {
      await job.moveToDelayed(Date.now() + MEMORY_RECHECK_MS, token);
      throw new DelayedError();
    }

    const { textBackMessage } = await this.tools.settings(orgId);
    const text = fillTemplate(textBackMessage, await this.activity.leadVariables(orgId, leadId));
    let sent: { id?: string };
    try {
      sent = await this.sms.sendSms(orgId, lead.phone, text);
    } catch (error) {
      const message = (error as Error).message;
      // Tried again by the queue; only the last failure is recorded, and the promise is then given up.
      if (job.attemptsMade + 1 < (job.opts.attempts ?? 1)) throw error;
      await this.activity.recordSms(orgId, leadId, text, false, message);
      return drop(`The text could not be sent: ${message}`);
    }
    // It went out: nothing below may throw, or the queue would send it twice. textBackAt stays as when it
    // was due, so a sequence step after it still gives the lead time to answer.
    try {
      await this.activity.recordSms(orgId, leadId, text, true, sent.id);
      await this.conversations.appendOurMessage(orgId, lead.phone, text).catch(() => undefined);
      this.state.quietly({ orgId, leadId, type: 'text_back_sent', source: 'text_back', channel: 'sms', payload: { at } });
    } catch (error) {
      this.logger.warn(`text back for lead ${leadId} was sent, but recording it failed: ${(error as Error).message}`);
    }
  }

  /** The lead's latest call is still live, or ended moments ago and its answers are not saved yet. */
  private async callAnswersPending(leadId: string): Promise<boolean> {
    const call = await this.prisma.call.findFirst({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, disposition: true, endedAt: true, extractedIntel: true },
    });
    if (!call) return false;
    if (call.status === CallStatus.ringing || call.status === CallStatus.in_progress) return true;
    if (call.status !== CallStatus.completed || call.disposition === CallDisposition.voicemail || !call.endedAt) return false;
    if (Date.now() - call.endedAt.getTime() > MEMORY_WAIT_MAX_MS) return false;
    return !(call.extractedIntel as { qualification?: unknown } | null)?.qualification;
  }

  private clear(leadId: string, at: string) {
    return this.prisma.lead.updateMany({ where: { id: leadId, textBackAt: new Date(at) }, data: { textBackAt: null } });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TextBackJobData> | undefined, error: Error): void {
    if (!job || error instanceof DelayedError) return;
    this.logger.error(`Text-back job ${job.id} for lead ${job.data.leadId} failed on attempt ${job.attemptsMade}: ${error.message}`);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Text-back worker error: ${error.message}`);
  }
}

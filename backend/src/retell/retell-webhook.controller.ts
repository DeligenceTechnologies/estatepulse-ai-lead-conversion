import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { LeadStatus, type Call } from '@prisma/client';
import type { Request } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { verifyRetellSignature } from '@/common/utils/crypto';
import { ActivityService } from '@/telnyx/activity.service';
import { EngineService } from '@/telnyx/engine.service';
import { LeadScoringService } from '@/telnyx/lead-scoring.service';
import { extractionFromRetell } from './retell-analysis';
import { RetellCredentialsService } from './retell-credentials.service';
import { RetellEnabledGuard } from './retell-enabled.guard';

interface RetellCall {
  call_id?: string;
  disconnection_reason?: string;
  recording_url?: string;
  transcript?: string;
  call_analysis?: unknown;
}

/**
 * Call events from the organization's Retell agent. Every delivery must carry
 * a valid signature from the workspace's webhook key; one for a call we did
 * not place yet answers 404 so Retell retries it (it retries up to three
 * times), and a retried event that already landed changes nothing.
 */
@Public()
@UseGuards(RetellEnabledGuard)
@Controller('webhooks/retell')
export class RetellWebhookController {
  private readonly logger = new Logger('RetellWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    private readonly activity: ActivityService,
    private readonly scoring: LeadScoringService,
    private readonly engine: EngineService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Body() body: any, @Req() req: RawBodyRequest<Request>): Promise<void> {
    const event: unknown = body?.event;
    const payload = (body?.call ?? {}) as RetellCall;
    if (typeof event !== 'string' || typeof payload.call_id !== 'string') return;

    const call = await this.prisma.call.findFirst({ where: { providerCallId: payload.call_id, provider: 'retell' }, orderBy: { createdAt: 'desc' } });
    if (!call) throw new AppError('NOT_FOUND', 'Unknown call');
    const c = await this.creds.getCreds(call.orgId);
    if (!verifyRetellSignature({ key: c?.webhookKey ?? '', header: req.header('x-retell-signature'), rawBody: req.rawBody })) {
      this.logger.warn(`Retell event for org ${call.orgId} failed signature verification — ignored`);
      throw new AppError('UNAUTHENTICATED', 'Bad signature');
    }

    if (event === 'call_started') await this.started(call);
    else if (event === 'call_ended') await this.ended(call, payload);
    else if (event === 'call_analyzed') await this.analyzed(call, payload);
  }

  private async started(call: Call): Promise<void> {
    if (call.endedAt || call.status !== 'ringing') return;
    await this.activity.onCallAnswered(call.providerCallId!);
  }

  private async ended(call: Call, payload: RetellCall): Promise<void> {
    if (call.endedAt) return;
    const reason = String(payload.disconnection_reason ?? '');
    await this.activity.onCallHangup(call.providerCallId!, { hangup_cause: reason });
    if (reason === 'user_requested_dnc') {
      await this.engine
        .setStatus(call.orgId, call.leadId, LeadStatus.not_interested, 'Asked on the call not to be contacted again', { optOut: true })
        .catch((error) => this.logger.error(`DNC for lead ${call.leadId}: ${(error as Error).message}`));
    }
  }

  /** Recording and transcript only when the organization records calls; the qualification either way. */
  private async analyzed(call: Call, payload: RetellCall): Promise<void> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId: call.orgId }, select: { callRecordingEnabled: true } });
    if (settings?.callRecordingEnabled ?? true) {
      const data = { ...(payload.recording_url ? { recordingUrl: payload.recording_url } : {}), ...(payload.transcript ? { transcript: payload.transcript } : {}) };
      if (Object.keys(data).length) await this.prisma.call.update({ where: { id: call.id }, data });
    }
    // Only a call that connected is scored; in_progress covers call_analyzed overtaking call_ended.
    const connected = call.status === 'completed' || call.status === 'in_progress';
    const extraction = connected ? extractionFromRetell(payload.call_analysis) : null;
    if (extraction) await this.scoring.onProviderAnalysis(call.id, extraction, 'retell_analysis');
  }
}

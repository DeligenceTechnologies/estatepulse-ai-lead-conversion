import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { safeEqual, sha256Hex, verifyRetellSignature, verifyTelnyxSignature } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { RetellCredentialsService } from '@/retell/retell-credentials.service';
import { TelnyxCredentialsService } from '@/telnyx/telnyx-credentials.service';
import { InCallBookingSettingsService, type InCallBookingConfig } from './in-call-booking-settings.service';

export interface ToolContext {
  orgId: string;
  leadId: string;
  callId: string;
  config: InCallBookingConfig;
}

export interface ToolRequest {
  authorization: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  callControlId: unknown;
  leadId: unknown;
}

export interface RetellToolRequest {
  authorization: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | undefined;
  callId: unknown;
}

/**
 * Proves a booking tool request came from the organization's own assistant,
 * during one of its live calls: the bearer token (only its hash is stored)
 * and a call_control_id that is one of our calls in progress. The lead and
 * the organization are the call's, never the request's. With a saved Telnyx
 * public key the signature is checked too. Every refusal looks the same to
 * the caller; outside production the reason is included for diagnosis.
 */
@Injectable()
export class ToolAuthService {
  private readonly logger = new Logger(ToolAuthService.name);
  private readonly production: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InCallBookingSettingsService,
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
    private readonly retellCreds: RetellCredentialsService,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * The same proof for the Retell agent's custom functions: our bearer token
   * from the tool's headers, a live Retell call, and Retell's signature. The
   * docs disagree on which workspace key signs tool calls, so either of the
   * organization's two keys may.
   */
  async verifyRetell(req: RetellToolRequest): Promise<ToolContext> {
    const deny = (why: string): never => {
      this.logger.warn(`booking tool request refused: ${why}`);
      throw new AppError('UNAUTHENTICATED', this.production ? 'Not authorized' : `Not authorized: ${why}`);
    };

    const token = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '')?.[1];
    if (!token) return deny('no bearer token');
    if (typeof req.callId !== 'string' || !req.callId) return deny('no call id');

    const call = await this.prisma.call.findFirst({
      where: { providerCallId: req.callId, provider: 'retell' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, orgId: true, leadId: true, status: true },
    });
    if (!call) return deny('unknown call');

    const config = await this.settings.activeConfig(call.orgId);
    if (config?.provider !== 'retell') return deny(`in-call booking is off on Retell for ${call.orgId}`);
    if (!safeEqual(sha256Hex(token), config.tokenHash)) return deny('bad token');
    if (call.status !== 'in_progress') return deny(`call ${call.id} is ${call.status}, not live`);

    const r = await this.retellCreds.getCreds(call.orgId).catch(() => null);
    const signed = [r?.webhookKey, r?.apiKey].some((key) => !!key && verifyRetellSignature({ key, header: req.signature, rawBody: req.rawBody }));
    if (!signed) return deny('bad Retell signature');

    return { orgId: call.orgId, leadId: call.leadId, callId: call.id, config };
  }

  async verify(req: ToolRequest): Promise<ToolContext> {
    const deny = (why: string): never => {
      this.logger.warn(`booking tool request refused: ${why}`);
      throw new AppError('UNAUTHENTICATED', this.production ? 'Not authorized' : `Not authorized: ${why}`);
    };

    const token = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '')?.[1];
    if (!token) return deny('no bearer token');
    if (typeof req.callControlId !== 'string' || !req.callControlId) return deny('no call_control_id');

    const call = await this.prisma.call.findFirst({
      where: { providerCallId: req.callControlId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, orgId: true, leadId: true, status: true },
    });
    if (!call) return deny('unknown call');

    const config = await this.settings.activeConfig(call.orgId);
    if (!config) return deny(`in-call booking is off for ${call.orgId}`);
    if (!safeEqual(sha256Hex(token), config.tokenHash)) return deny('bad token');
    if (req.leadId !== call.leadId) {
      this.logger.warn(`booking tool: lead_id ${JSON.stringify(req.leadId)} is not call ${call.id}'s lead; using the call's lead`);
    }
    if (call.status !== 'in_progress') return deny(`call ${call.id} is ${call.status}, not live`);

    const c = await this.creds.getCreds(call.orgId).catch(() => null);
    if (c?.publicKey && !verifyTelnyxSignature({ publicKey: c.publicKey, ...req })) return deny('bad Telnyx signature');

    return { orgId: call.orgId, leadId: call.leadId, callId: call.id, config };
  }
}

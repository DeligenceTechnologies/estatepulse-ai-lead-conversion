import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { safeEqual, sha256Hex, verifyRetellSignature } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { RetellCredentialsService } from '@/retell/retell-credentials.service';
import { AssistantToolAuth, type AssistantToolCaller, type ToolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
import { InCallBookingSettingsService, type InCallBookingConfig } from './in-call-booking-settings.service';

export type { ToolRequest } from '@/telnyx/tools/assistant-tool-auth.service';

export interface ToolContext extends AssistantToolCaller {
  config: InCallBookingConfig;
}

/** A Retell custom-function call: our bearer token from the tool, the call it was used on, and Retell's signature. */
export interface RetellToolRequest {
  authorization: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | undefined;
  callId: unknown;
}

/**
 * Proves a booking tool request came from the organization's own assistant
 * (see AssistantToolAuth), with the booking tools' token, while in-call
 * booking is on.
 */
@Injectable()
export class ToolAuthService {
  private readonly logger = new Logger(ToolAuthService.name);
  private readonly production: boolean;

  constructor(
    private readonly auth: AssistantToolAuth,
    private readonly settings: InCallBookingSettingsService,
    private readonly prisma: PrismaService,
    private readonly retellCreds: RetellCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  async verify(req: ToolRequest): Promise<ToolContext> {
    const configs = new Map<string, InCallBookingConfig>();
    const caller = await this.auth.verify(req, 'booking', async (orgId) => {
      const config = await this.settings.activeConfig(orgId);
      if (config) configs.set(orgId, config);
      return config?.tokenHash ?? null;
    });
    return { ...caller, config: configs.get(caller.orgId)! };
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
}

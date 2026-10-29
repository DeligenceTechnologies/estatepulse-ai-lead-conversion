import { Injectable, Logger, type RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { safeEqual, sha256Hex, verifyRetellSignature } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import type { AssistantToolCaller, TokenHashFor } from '@/telnyx/tools/assistant-tool-auth.service';
import { RetellCredentialsService } from './retell-credentials.service';

/** A Retell custom-function call: our bearer token from the tool, the call or chat it was used in, and Retell's signature. */
export interface RetellToolRequest {
  authorization: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | undefined;
  /** Retell puts the call in the request body (`call.call_id`). */
  callId: unknown;
  /** In a text chat the id comes from the tool URL's `chat_id={{chat_id}}` query. */
  chatId: unknown;
}

export const retellToolRequest = (req: RawBodyRequest<Request>, body: any): RetellToolRequest => ({
  authorization: req.header('authorization'),
  signature: req.header('x-retell-signature'),
  rawBody: req.rawBody,
  callId: body?.call?.call_id,
  chatId: req.query?.chat_id ?? body?.chat?.chat_id,
});

/** The tool's arguments: under `args` as Retell documents, or at the root when the tool was set to send only them. */
export const retellToolArgs = (body: any): Record<string, unknown> => (body && typeof body === 'object' && body.args && typeof body.args === 'object' ? body.args : (body ?? {}));

/**
 * Proves a tool request came from the organization's own Retell agent: the
 * bearer token of that kind of tool (only its hash is stored), a live call of
 * ours or an ongoing text chat of ours, and Retell's signature over the body.
 * The lead and the organization come from the call or chat record, never from
 * the request. The docs disagree on which workspace key signs tool calls, so
 * either of the organization's two keys may. Every refusal looks the same to
 * the caller; outside production the reason is included for diagnosis.
 */
@Injectable()
export class RetellToolAuthService {
  private readonly logger = new Logger(RetellToolAuthService.name);
  private readonly production: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  async verify(req: RetellToolRequest, kind: string, hashFor: TokenHashFor): Promise<AssistantToolCaller> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '')?.[1];
    if (!token) return this.deny(kind, 'no bearer token');
    const callId = typeof req.callId === 'string' && req.callId ? req.callId : '';
    const chatId = typeof req.chatId === 'string' && req.chatId && !req.chatId.startsWith('{{') ? req.chatId : '';
    if (!callId && !chatId) return this.deny(kind, 'no call id');

    let caller: AssistantToolCaller;
    if (callId) {
      const call = await this.prisma.call.findFirst({
        where: { providerCallId: callId, provider: 'retell' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, orgId: true, leadId: true, status: true },
      });
      if (!call) return this.deny(kind, 'unknown call');
      await this.checkToken(kind, call.orgId, token, hashFor);
      if (call.status !== 'in_progress') return this.deny(kind, `call ${call.id} is ${call.status}, not live`);
      caller = { orgId: call.orgId, leadId: call.leadId, callId: call.id, provider: 'retell' };
    } else {
      const chat = await this.prisma.smsChat.findFirst({
        where: { provider: 'retell', providerChatId: chatId },
        select: { id: true, orgId: true, leadId: true, status: true },
      });
      if (!chat) return this.deny(kind, 'unknown chat');
      await this.checkToken(kind, chat.orgId, token, hashFor);
      if (chat.status !== 'ongoing') return this.deny(kind, `chat ${chat.id} is ${chat.status}, not ongoing`);
      caller = { orgId: chat.orgId, leadId: chat.leadId, callId: null, provider: 'retell' };
    }

    const r = await this.creds.getCreds(caller.orgId).catch(() => null);
    const signed = [r?.webhookKey, r?.apiKey].some((key) => !!key && verifyRetellSignature({ key, header: req.signature, rawBody: req.rawBody }));
    if (!signed) return this.deny(kind, 'bad Retell signature');
    return caller;
  }

  private async checkToken(kind: string, orgId: string, token: string, hashFor: TokenHashFor): Promise<void> {
    const hash = await hashFor(orgId);
    if (!hash) this.deny(kind, `${kind} tools are off for ${orgId}`);
    if (!safeEqual(sha256Hex(token), hash!)) this.deny(kind, 'bad token');
  }

  private deny(kind: string, why: string): never {
    this.logger.warn(`${kind} tool request refused: ${why}`);
    throw new AppError('UNAUTHENTICATED', this.production ? 'Not authorized' : `Not authorized: ${why}`);
  }
}

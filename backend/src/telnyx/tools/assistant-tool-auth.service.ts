import { Injectable, Logger, type RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { safeEqual, sha256Hex, verifyTelnyxSignature } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { normalizePhone } from '../phone';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';

/** Where an assistant's tool was used: a live call, or (callId null) a text chat with the lead. */
export interface AssistantToolCaller {
  orgId: string;
  leadId: string;
  /** The live call the tool was used on; null in a text chat. */
  callId: string | null;
  /** Whose agent used the tool; Telnyx when absent. */
  provider?: 'telnyx' | 'retell';
}

export interface ToolRequest {
  authorization: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  callControlId: unknown;
  leadId: unknown;
  /** The lead's number in a text chat ({{telnyx_end_user_target}}); absent on tools created before text chats. */
  endUser?: unknown;
}

/** The hash of the bearer token an organization's tools of one kind carry; null when that kind is off for it. */
export type TokenHashFor = (orgId: string) => Promise<string | null>;

export const toolRequest = (req: RawBodyRequest<Request>, body: any): ToolRequest => ({
  authorization: req.header('authorization'),
  signature: req.header('telnyx-signature-ed25519'),
  timestamp: req.header('telnyx-timestamp'),
  rawBody: req.rawBody,
  callControlId: body?.call_control_id,
  leadId: body?.lead_id,
  endUser: body?.end_user,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Telnyx variable left unfilled reaches us as its own template, or empty. */
const filled = (value: unknown): string => (typeof value === 'string' && value && !value.startsWith('{{') ? value : '');

/**
 * Proves a tool request came from the organization's own assistant: the
 * bearer token of that kind of tool (only its hash is stored), plus either a
 * call_control_id that is one of our calls in progress, or, in a text chat (no
 * call), a lead of the org that has AI text conversations on, whose number is
 * the chat's. The lead and the organization come from the call or the lead
 * record, never from the request alone. With a saved Telnyx public key the
 * signature is checked too. Every refusal looks the same to the caller;
 * outside production the reason is included for diagnosis.
 */
@Injectable()
export class AssistantToolAuth {
  private readonly logger = new Logger(AssistantToolAuth.name);
  private readonly production: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /** `kind` names the tools in log lines ("booking", "call outcome"). */
  async verify(req: ToolRequest, kind: string, hashFor: TokenHashFor): Promise<AssistantToolCaller> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '')?.[1];
    if (!token) return this.deny(kind, 'no bearer token');
    const ccid = filled(req.callControlId);
    return ccid ? this.verifyCall(req, kind, hashFor, token, ccid) : this.verifyChat(req, kind, hashFor, token);
  }

  private async verifyCall(req: ToolRequest, kind: string, hashFor: TokenHashFor, token: string, ccid: string): Promise<AssistantToolCaller> {
    const call = await this.prisma.call.findFirst({
      where: { providerCallId: ccid },
      orderBy: { createdAt: 'desc' },
      select: { id: true, orgId: true, leadId: true, status: true },
    });
    if (!call) return this.deny(kind, 'unknown call');

    const hash = await hashFor(call.orgId);
    if (!hash) return this.deny(kind, `${kind} tools are off for ${call.orgId}`);
    if (!safeEqual(sha256Hex(token), hash)) return this.deny(kind, 'bad token');
    if (req.leadId !== call.leadId) {
      this.logger.warn(`${kind} tool: lead_id ${JSON.stringify(req.leadId)} is not call ${call.id}'s lead; using the call's lead`);
    }
    if (call.status !== 'in_progress') return this.deny(kind, `call ${call.id} is ${call.status}, not live`);
    await this.checkSignature(kind, call.orgId, req);
    return { orgId: call.orgId, leadId: call.leadId, callId: call.id };
  }

  private async verifyChat(req: ToolRequest, kind: string, hashFor: TokenHashFor, token: string): Promise<AssistantToolCaller> {
    const lead = await this.chatLead(req, hashFor, token);
    if (!lead) {
      return this.deny(kind, `no lead for this text chat (lead_id ${JSON.stringify(req.leadId)}, end_user ${filled(req.endUser) ? 'given' : 'missing'})`);
    }

    const hash = await hashFor(lead.orgId);
    if (!hash) return this.deny(kind, `${kind} tools are off for ${lead.orgId}`);
    if (!safeEqual(sha256Hex(token), hash)) return this.deny(kind, 'bad token');
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId: lead.orgId }, select: { smsConversation: true } });
    if (!(row?.smsConversation as { enabled?: boolean } | null)?.enabled) return this.deny(kind, `text conversations are off for ${lead.orgId}`);
    const endUser = filled(req.endUser);
    if (endUser && normalizePhone(endUser) !== lead.normalizedPhone) return this.deny(kind, `the chat's number is not lead ${lead.id}'s`);
    await this.checkSignature(kind, lead.orgId, req);
    return { orgId: lead.orgId, leadId: lead.id, callId: null };
  }

  /**
   * The chat's lead. Telnyx fills only its own variables in a text chat's tool
   * presets, so {{leadId}} arrives unfilled; the lead is then the newest one
   * with the chat's number in the organization this token belongs to.
   */
  private async chatLead(
    req: ToolRequest,
    hashFor: TokenHashFor,
    token: string,
  ): Promise<{ id: string; orgId: string; normalizedPhone: string | null } | null> {
    const select = { id: true, orgId: true, normalizedPhone: true } as const;
    const leadId = filled(req.leadId);
    if (UUID.test(leadId)) return this.prisma.lead.findUnique({ where: { id: leadId }, select });

    const phone = normalizePhone(filled(req.endUser));
    if (!phone) return null;
    const leads = await this.prisma.lead.findMany({ where: { normalizedPhone: phone }, orderBy: { createdAt: 'desc' }, take: 20, select });
    const hash = sha256Hex(token);
    for (const orgId of [...new Set(leads.map((l) => l.orgId))]) {
      const own = await hashFor(orgId);
      if (own && safeEqual(hash, own)) return leads.find((l) => l.orgId === orgId) ?? null;
    }
    return null;
  }

  private async checkSignature(kind: string, orgId: string, req: ToolRequest): Promise<void> {
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (c?.publicKey && !verifyTelnyxSignature({ publicKey: c.publicKey, ...req })) this.deny(kind, 'bad Telnyx signature');
  }

  private deny(kind: string, why: string): never {
    this.logger.warn(`${kind} tool request refused: ${why}`);
    throw new AppError('UNAUTHENTICATED', this.production ? 'Not authorized' : `Not authorized: ${why}`);
  }
}

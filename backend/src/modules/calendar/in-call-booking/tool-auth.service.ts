import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredStoreService } from '../../../telnyx/cred-store.service';
import { verifyTelnyxSignature } from '../../../telnyx/telnyx-signature';
import { InCallBookingSettingsService, sha256, type InCallBookingConfig } from './in-call-booking-settings.service';

/** Who a verified tool request is for. */
export interface ToolContext {
  organizationId: string;
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

/**
 * Proves a booking tool request came from the office's own assistant, during a
 * live call, about that call's lead. There is no user session on a phone call,
 * so the request has to carry all of it:
 *
 *  1. the office's bearer token (an integration secret in its Telnyx account;
 *     we hold only the hash) — compared in constant time;
 *  2. a call_control_id that is one of OUR calls and is in progress right now.
 *
 * The lead is the CALL's lead, taken from our own call row — never from the
 * request. The preset lead_id Telnyx sends is only cross-checked and logged if
 * it disagrees: it adds no protection (nothing acts on it), and requiring it
 * made a live call fail whenever Telnyx rendered that variable differently.
 * call_control_id is a preset tool field, filled by Telnyx and not by the
 * model. The organization comes from the call row, never the body. When
 * the office has saved its Telnyx public key, the Ed25519 signature is checked
 * as well.
 *
 * Every refusal is the same UNAUTHENTICATED, so a probe learns nothing about
 * which check failed; the log says which. Outside production the reason is
 * also in the response, so it lands in Telnyx's record of the call and a
 * failed test call can be diagnosed after the fact.
 */
@Injectable()
export class ToolAuthService {
  private readonly logger = new Logger(ToolAuthService.name);

  constructor(
    // Unscoped for one lookup: finding the call IS how the tenant is discovered.
    private readonly unscoped: PrismaService,
    private readonly settings: InCallBookingSettingsService,
    private readonly creds: CredStoreService,
    private readonly config: ConfigService,
  ) {}

  async verify(req: ToolRequest): Promise<ToolContext> {
    const deny = (why: string): never => {
      this.logger.warn(`booking tool request refused: ${why}`);
      const production = this.config.get<string>('NODE_ENV') === 'production';
      throw new AppError('UNAUTHENTICATED', production ? 'Not authorized' : `Not authorized: ${why}`);
    };

    const token = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '')?.[1];
    if (!token) deny('no bearer token');
    if (typeof req.callControlId !== 'string' || !req.callControlId) deny('no call_control_id');

    const call = await this.unscoped.voice_calls.findFirst({
      where: { provider_call_id: req.callControlId as string },
      orderBy: { created_at: 'desc' },
      select: { id: true, organization_id: true, lead_id: true, status: true },
    });
    if (!call) return deny('unknown call');

    const config = await this.settings.activeConfig(call.organization_id);
    if (!config) return deny(`in-call booking is off for ${call.organization_id}`);

    const got = Buffer.from(sha256(token!));
    const want = Buffer.from(config.tokenHash);
    if (got.length !== want.length || !timingSafeEqual(got, want)) deny('bad token');
    if (req.leadId !== call.lead_id) {
      this.logger.warn(`booking tool: lead_id ${JSON.stringify(req.leadId)} ≠ call ${call.id}'s lead; using the call's lead`);
    }
    if (call.status !== 'in_progress') deny(`call ${call.id} is ${call.status}, not live`);

    const c = await this.creds.getCreds(call.organization_id).catch(() => null);
    if (c?.publicKey && !verifyTelnyxSignature({ publicKey: c.publicKey, ...req })) deny('bad Telnyx signature');

    return { organizationId: call.organization_id, leadId: call.lead_id, callId: call.id, config };
  }
}

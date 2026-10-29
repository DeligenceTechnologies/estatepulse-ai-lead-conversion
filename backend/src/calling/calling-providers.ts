import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import type { CallIntent } from '@/telnyx/calls/call.types';
import { RetellCallingProvider } from '@/retell/retell-calling.provider';
import { retellEnabled } from '@/retell/retell-enabled.guard';
import { CallCapacityService } from '@/telnyx/calls/call-capacity.service';
import { SmsService } from '@/telnyx/sms.service';
import { VoiceService } from '@/telnyx/voice.service';

export type CallingProviderName = 'telnyx' | 'retell';

/** The fallback wording when a provider gives no reason of its own for an SMS step being skipped. */
export const SMS_UNAVAILABLE = 'SMS is not set up for this calling provider.';

/**
 * Whether the organization's provider can text right now.
 * - ready: texts go out and the provider reports delivery per message (Telnyx).
 * - unverified: texts go out, but a registration the provider does not expose
 *   (Retell's A2P 10DLC approval) decides whether carriers accept them.
 * - not_configured / no_number / unsupported_number / unavailable: no text is attempted.
 */
export type SmsReadiness = 'ready' | 'unverified' | 'not_configured' | 'no_number' | 'unsupported_number' | 'unavailable';

export interface SmsCapability {
  /** A text can be attempted now. */
  available: boolean;
  state: SmsReadiness;
  /** Why not, or what cannot be verified; shown wherever an SMS step appears. Null when ready. */
  reason: string | null;
  /** The provider reports delivered / failed per message. Retell only accepts the chat. */
  deliveryReports: boolean;
}

export const SMS_READY: SmsCapability = { available: true, state: 'ready', reason: null, deliveryReports: true };

/** What the step that placed the call wants from it travels with the call, on either provider. */
export interface CallContext extends CallIntent {
  orgId: string;
  leadId: string;
  sequenceId?: string;
}

/** What the call worker, the strategy engine and follow-ups need from whoever places the call or sends the text. */
export interface CallingProvider {
  readonly name: CallingProviderName;
  /** The provider can text at all; smsCapability() says whether this organization's setup can right now. */
  readonly capabilities: { sms: boolean };
  startCall(orgId: string, to: string, ctx: CallContext): Promise<{ providerCallId?: string }>;
  /** Looked at before every SMS step: a step the provider cannot send is skipped, with the reason, before it is called. */
  smsCapability(orgId: string): Promise<SmsCapability>;
  /** `ctx.leadId` lets a provider that keeps a conversation per lead (Retell) file the text under it. */
  sendSms(orgId: string, to: string, text: string, ctx?: { leadId?: string }): Promise<{ id?: string }>;
  /** The concurrent-call limit the provider itself reports, if it reports one. */
  providerLimit(orgId: string): Promise<number | null>;
}

/** Telnyx exactly as before: each call is handed, as it came, to the existing Telnyx service. */
@Injectable()
export class TelnyxCallingProvider implements CallingProvider {
  readonly name = 'telnyx' as const;
  readonly capabilities = { sms: true };

  constructor(
    private readonly voice: VoiceService,
    private readonly sms: SmsService,
    private readonly capacity: CallCapacityService,
  ) {}

  async startCall(orgId: string, to: string, ctx: CallContext): Promise<{ providerCallId?: string }> {
    const call = await this.voice.placeCall(orgId, to, { ...ctx });
    return { providerCallId: call.call_control_id };
  }

  /** Telnyx texts from the organization's number as before; a missing number fails the send itself, as it always did. */
  async smsCapability(): Promise<SmsCapability> {
    return SMS_READY;
  }

  sendSms(orgId: string, to: string, text: string): Promise<{ id?: string }> {
    return this.sms.sendSms(orgId, to, text);
  }

  async providerLimit(orgId: string): Promise<number | null> {
    return (await this.capacity.status(orgId)).telnyxLimit;
  }
}

/**
 * The organization's calling provider. An organization calls through Telnyx
 * or Retell, never both; its one active calling integration (a unique index
 * holds that) is the only record of which. With RETELL_ENABLED off this never
 * reads the database: every organization is on Telnyx, as before.
 */
@Injectable()
export class CallingProviders {
  private readonly retellOn: boolean;

  constructor(
    config: ConfigService<IntegrationEnv, true>,
    private readonly prisma: PrismaService,
    private readonly telnyx: TelnyxCallingProvider,
    private readonly retell: RetellCallingProvider,
  ) {
    this.retellOn = retellEnabled(config);
  }

  async nameFor(orgId: string): Promise<CallingProviderName> {
    if (!this.retellOn) return 'telnyx';
    const retell = await this.prisma.integration.findFirst({
      where: { orgId, provider: IntegrationProvider.retell, status: IntegrationStatus.active, revokedAt: null },
      select: { id: true },
    });
    return retell ? 'retell' : 'telnyx';
  }

  async for(orgId: string): Promise<CallingProvider> {
    return (await this.nameFor(orgId)) === 'retell' ? this.retell : this.telnyx;
  }
}

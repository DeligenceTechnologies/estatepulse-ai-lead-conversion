import { Injectable } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { isSuppressed } from '@/lead/contact-suppression';
import { normalizePhone } from './phone';
import { isCanadian, withOutreachFooter } from './sms/sms-compliance';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { isTelnyxKeyRejected, telnyx } from './telnyx-api';

/** Nothing will reach the number: it is on our do-not-contact list, or Telnyx blocks it because it replied STOP (40300). */
export class OptedOutError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

/** When an outreach text that failed for a passing reason is tried again: twice, a minute and then five minutes later. */
export const SMS_RETRY_DELAYS_MS = [60_000, 5 * 60_000];

/**
 * Whether a failed request's message carries this Telnyx error code: "(40300)"
 * as telnyxErrorText words it, or raw JSON where the body could not be read.
 */
export const hasTelnyxCode = (message: string, code: string): boolean =>
  new RegExp(`\\(${code}\\)|"code"\\s*:\\s*"${code}"`).test(message);

/**
 * Whether a failed send may get through if tried again: Telnyx was busy or
 * failing (429, a 5xx, its sending queue full: 40318) or could not be reached.
 * Not for anything about the text or the number (invalid, landline, blocked),
 * and not after a timeout, when the text may have gone out and a retry could
 * send it twice.
 */
export function isTransientSmsError(error: unknown): boolean {
  if (error instanceof OptedOutError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Telnyx unreachable')) return !/abort|timeout|timed out/i.test(message);
  if (hasTelnyxCode(message, '40318')) return true;
  const status = Number(/ failed (\d{3}):/.exec(message)?.[1]);
  return status === 429 || status >= 500;
}

export interface SmsSendOptions {
  /** Only for the texts the rules require after an opt-out: its confirmation and a HELP answer. */
  evenIfOptedOut?: boolean;
  /** A strategy or sequence step: it gets who is texting and how to stop when the rules ask for them (sms-compliance.ts). */
  outreach?: boolean;
}

@Injectable()
export class SmsService {
  constructor(
    private readonly creds: TelnyxCredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Every text we send goes through here, so a number that opted out is
   * refused here whoever sends it. Returns the text as it went out, which an
   * outreach footer may have lengthened.
   */
  async sendSms(orgId: string, to: string, text: string, opts: SmsSendOptions = {}): Promise<{ id?: string; text: string }> {
    const phone = normalizePhone(to);
    if (!opts.evenIfOptedOut && (await isSuppressed(this.prisma, orgId, phone))) {
      throw new OptedOutError('This number asked not to be contacted');
    }
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');
    const body = opts.outreach ? await this.withFooter(orgId, phone, text, c.fromNumber) : text;
    let res: { data?: { id?: string } };
    try {
      res = await telnyx<{ data?: { id?: string } }>(c.apiKey, '/messages', {
        method: 'POST',
        body: JSON.stringify({ from: c.fromNumber, to, text: body }),
      });
    } catch (error) {
      if (isTelnyxKeyRejected(error)) await this.creds.keyRejected(orgId).catch(() => undefined);
      if (hasTelnyxCode((error as Error).message, '40300')) {
        throw new OptedOutError('Telnyx refused the text: this number replied STOP to us (40300)');
      }
      throw error;
    }
    await this.creds.keyAccepted(orgId, c).catch(() => undefined);
    return { ...(res.data?.id ? { id: res.data.id } : {}), text: body };
  }

  /** The first text to a number is the first one that reached it, from any lead record with the number. */
  private async withFooter(orgId: string, phone: string, text: string, ourNumber: string): Promise<string> {
    const [org, earlier] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
      this.prisma.message.count({
        where: { orgId, direction: 'outbound', channel: 'sms', deliveryStatus: { not: DeliveryStatus.failed }, lead: { orgId, normalizedPhone: phone } },
      }),
    ]);
    const brokerage = org?.name?.trim() || 'our team';
    return withOutreachFooter({ text, brokerage, ourNumber, canadian: isCanadian(phone), firstText: earlier === 0 });
  }
}

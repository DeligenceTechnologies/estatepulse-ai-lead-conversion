import { Injectable } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { isSuppressed } from '@/lead/contact-suppression';
import { normalizePhone } from './phone';
import { isCanadian, withOutreachFooter } from './sms/sms-compliance';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { isTelnyxKeyRejected, telnyx } from './telnyx-api';

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
      throw new AppError('CONFLICT', 'This number asked not to be contacted');
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

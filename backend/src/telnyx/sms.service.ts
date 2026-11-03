import { Injectable } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { isSuppressed } from '@/lead/contact-suppression';
import { normalizePhone } from './phone';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { isTelnyxKeyRejected, telnyx } from './telnyx-api';

@Injectable()
export class SmsService {
  constructor(
    private readonly creds: TelnyxCredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Every text we send goes through here, so a number that opted out is
   * refused here whoever sends it. `evenIfOptedOut` is only for the texts the
   * rules require after an opt-out: its confirmation and a HELP answer.
   */
  async sendSms(orgId: string, to: string, text: string, opts: { evenIfOptedOut?: boolean } = {}): Promise<{ id?: string }> {
    if (!opts.evenIfOptedOut && (await isSuppressed(this.prisma, orgId, normalizePhone(to)))) {
      throw new AppError('CONFLICT', 'This number asked not to be contacted');
    }
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');
    let res: { data?: { id?: string } };
    try {
      res = await telnyx<{ data?: { id?: string } }>(c.apiKey, '/messages', {
        method: 'POST',
        body: JSON.stringify({ from: c.fromNumber, to, text }),
      });
    } catch (error) {
      if (isTelnyxKeyRejected(error)) await this.creds.keyRejected(orgId).catch(() => undefined);
      throw error;
    }
    await this.creds.keyAccepted(orgId, c).catch(() => undefined);
    return res.data ?? {};
  }
}

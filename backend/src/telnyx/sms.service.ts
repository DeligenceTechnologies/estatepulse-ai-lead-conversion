import { Injectable } from '@nestjs/common';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { isTelnyxKeyRejected, telnyx } from './telnyx-api';

@Injectable()
export class SmsService {
  constructor(private readonly creds: TelnyxCredentialsService) {}

  async sendSms(orgId: string, to: string, text: string): Promise<{ id?: string }> {
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

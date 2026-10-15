import { Injectable } from '@nestjs/common';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { telnyx } from './telnyx-api';

@Injectable()
export class SmsService {
  constructor(private readonly creds: TelnyxCredentialsService) {}

  async sendSms(orgId: string, to: string, text: string): Promise<{ id?: string }> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');
    const res = await telnyx<{ data?: { id?: string } }>(c.apiKey, '/messages', {
      method: 'POST',
      body: JSON.stringify({ from: c.fromNumber, to, text }),
    });
    return res.data ?? {};
  }
}

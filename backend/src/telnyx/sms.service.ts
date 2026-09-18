import { Injectable } from '@nestjs/common';
import { CredStoreService } from './cred-store.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

@Injectable()
export class SmsService {
  constructor(private readonly creds: CredStoreService) {}

  /**
   * Send an SMS from the org's own Telnyx number (standard long-code send).
   * We send with `from` only - the number already carries its own Messaging
   * Profile, so passing messaging_profile_id too makes Telnyx try the profile's
   * alphanumeric sender and fail with 40306 when none is configured.
   */
  async sendSms(orgId: string, to: string, text: string): Promise<any> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');

    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.fromNumber, to, text }),
    });
    if (!res.ok) throw new Error(`SMS send failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return j.data ?? j;
  }
}

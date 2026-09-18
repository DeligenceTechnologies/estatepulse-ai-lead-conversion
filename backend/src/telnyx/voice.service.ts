import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredStoreService } from './cred-store.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

@Injectable()
export class VoiceService {
  constructor(
    private readonly creds: CredStoreService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Place an outbound AI qualification call from the org's Telnyx number.
   * The Call Control connection id is derived from the connected number if the
   * org never set one explicitly. On answer the AI assistant is attached via the
   * Call Control webhook.
   */
  async placeCall(orgId: string, to: string, clientState: Record<string, unknown>): Promise<any> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');

    // Always resolve via the resolver: it keeps a valid Call Control app or repairs
    // a stale/invalid one (e.g. an assistant connection Telnyx rejects with 10015).
    const connectionId = await this.creds.ensureConnectionId(orgId, c);
    if (!connectionId) {
      throw new Error('No Call Control application found on the Telnyx account for outbound calls');
    }

    const publicUrl = this.config.get<string>('PUBLIC_API_URL');

    const res = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id: connectionId,
        to,
        from: c.fromNumber,
        client_state: Buffer.from(JSON.stringify(clientState)).toString('base64'),
        ...(publicUrl ? { webhook_url: `${publicUrl}/api/webhooks/telnyx/voice` } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Call failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return j.data ?? j;
  }
}

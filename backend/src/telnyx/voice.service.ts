import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { telnyx } from './telnyx-api';

/**
 * How long a dial rings before Telnyx gives up. Its default of 30s is too short
 * abroad: an international call can take 10-15s just to start ringing.
 */
const DIAL_TIMEOUT_SECS = 60;

@Injectable()
export class VoiceService {
  private readonly publicUrl: string;

  constructor(
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  async placeCall(orgId: string, to: string, clientState: Record<string, unknown>): Promise<{ call_control_id?: string }> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');
    const connectionId = await this.creds.ensureConnectionId(orgId, c);
    if (!connectionId) throw new Error('No Call Control application found on the Telnyx account for outbound calls');
    const res = await telnyx<{ data?: { call_control_id?: string } }>(c.apiKey, '/calls', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        to,
        from: c.fromNumber,
        timeout_secs: DIAL_TIMEOUT_SECS,
        // Tells a person from an answering machine, so the assistant never talks to a voicemail greeting.
        answering_machine_detection: 'premium',
        client_state: Buffer.from(JSON.stringify(clientState)).toString('base64'),
        ...(this.publicUrl ? { webhook_url: `${this.publicUrl}/webhooks/telnyx/voice` } : {}),
      }),
    });
    return res.data ?? {};
  }
}

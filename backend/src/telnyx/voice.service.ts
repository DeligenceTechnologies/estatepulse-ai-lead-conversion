import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { isTelnyxKeyRejected, telnyx } from './telnyx-api';
import { VoicemailService } from './voicemail/voicemail.service';

/**
 * How long a dial rings before Telnyx gives up. Its default of 30s is too short
 * abroad: an international call can take 10-15s just to start ringing.
 */
const DIAL_TIMEOUT_SECS = 60;
/** How long a successful reachability probe of the webhook URL is trusted, and a failed one remembered. */
const WEBHOOK_OK_TTL_MS = 60_000;
const WEBHOOK_DOWN_TTL_MS = 15_000;
const WEBHOOK_PROBE_TIMEOUT_MS = 5_000;

/** Thrown before dialing when Telnyx could not reach us: the call would be answered into silence. */
export const WEBHOOK_UNREACHABLE = 'Webhook unreachable';

@Injectable()
export class VoiceService {
  private readonly publicUrl: string;
  private webhook: { ok: boolean; until: number; reason: string } | null = null;
  private probing: Promise<void> | null = null;

  constructor(
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
    private readonly voicemail: VoicemailService,
  ) {
    this.publicUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  async placeCall(orgId: string, to: string, clientState: Record<string, unknown>): Promise<{ call_control_id?: string }> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new Error('No provider connected');
    if (!c.fromNumber) throw new Error('No from number configured');
    const connectionId = await this.creds.ensureConnectionId(orgId, c);
    if (!connectionId) throw new Error('No Call Control application found on the Telnyx account for outbound calls');
    // The assistant is only started from our call.answered webhook; dialing while Telnyx cannot reach us
    // rings the lead, who picks up and hears nothing.
    await this.assertWebhookReachable();
    // Tells a person from an answering machine, so the assistant never talks to a voicemail greeting.
    // A per-call charge, so only where the organization keeps it on; the webhooks learn which from client_state.
    const { detect } = await this.voicemail.settings(orgId);
    let res: { data?: { call_control_id?: string } };
    try {
      res = await telnyx<{ data?: { call_control_id?: string } }>(c.apiKey, '/calls', {
        method: 'POST',
        body: JSON.stringify({
          connection_id: connectionId,
          to,
          from: c.fromNumber,
          timeout_secs: DIAL_TIMEOUT_SECS,
          ...(detect ? { answering_machine_detection: 'premium' } : {}),
          client_state: Buffer.from(JSON.stringify({ ...clientState, amd: detect })).toString('base64'),
          ...(this.publicUrl ? { webhook_url: `${this.publicUrl}/webhooks/telnyx/voice` } : {}),
        }),
      });
    } catch (error) {
      if (isTelnyxKeyRejected(error)) await this.creds.keyRejected(orgId).catch(() => undefined);
      throw error;
    }
    await this.creds.keyAccepted(orgId, c).catch(() => undefined);
    return res.data ?? {};
  }

  /** Probes this API's health route through its public URL (the tunnel or load balancer Telnyx posts to). */
  private async assertWebhookReachable(): Promise<void> {
    if (!this.publicUrl) throw new Error(`${WEBHOOK_UNREACHABLE}: PUBLIC_API_URL is not set, so Telnyx has nowhere to send call events`);
    if (!this.webhook || this.webhook.until <= Date.now()) {
      this.probing ??= this.probeWebhook().finally(() => (this.probing = null));
      await this.probing;
    }
    if (!this.webhook?.ok) throw new Error(`${WEBHOOK_UNREACHABLE}: ${this.publicUrl} ${this.webhook?.reason ?? 'did not answer'}`);
  }

  private async probeWebhook(): Promise<void> {
    let reason = '';
    try {
      const res = await fetch(`${this.publicUrl}/health`, { signal: AbortSignal.timeout(WEBHOOK_PROBE_TIMEOUT_MS) });
      if (!res.ok) reason = `answered ${res.status}`;
    } catch (error) {
      reason = `did not answer (${(error as Error).message})`;
    }
    const ok = !reason;
    this.webhook = { ok, reason, until: Date.now() + (ok ? WEBHOOK_OK_TTL_MS : WEBHOOK_DOWN_TTL_MS) };
  }
}

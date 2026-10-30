import { Injectable } from '@nestjs/common';
import type { CallContext, CallingProvider, SmsCapability } from '@/calling/calling-providers';
import { ActivityService } from '@/telnyx/activity.service';
import { retell } from './retell-api';
import { RetellCredentialsService } from './retell-credentials.service';
import { RetellSmsService } from './retell-sms.service';
import { RetellToolsService } from './retell-tools.service';

/**
 * Retell places the call and runs the whole conversation on the
 * organization's agent; the lead's details travel as dynamic variables, the
 * same ones the Telnyx assistant gets. Texts go through the organization's
 * Retell SMS agent once that is set up on an eligible number; until then
 * every SMS step reports why it cannot be sent, and is never handed to Telnyx.
 */
@Injectable()
export class RetellCallingProvider implements CallingProvider {
  readonly name = 'retell' as const;
  readonly capabilities = { sms: true };

  constructor(
    private readonly creds: RetellCredentialsService,
    private readonly activity: ActivityService,
    private readonly sms: RetellSmsService,
    private readonly tools: RetellToolsService,
  ) {}

  async startCall(orgId: string, to: string, ctx: CallContext): Promise<{ providerCallId?: string }> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.active || !c.apiKey) throw new Error('No provider connected');
    if (!c.agentId) throw new Error('No Retell agent configured');
    if (!c.fromNumber) throw new Error('No from number configured');
    // The callback and outcome tools must be on the agent before it talks; never blocks the dial.
    await this.tools.ensure(orgId);
    const call = await retell<{ call_id?: string }>(c.apiKey, '/v2/create-phone-call', {
      method: 'POST',
      body: JSON.stringify({
        from_number: c.fromNumber,
        to_number: to,
        override_agent_id: c.agentId,
        retell_llm_dynamic_variables: await this.activity.leadVariables(orgId, ctx.leadId),
        metadata: { ...ctx },
        honor_internal_dnc: true,
      }),
    });
    return { providerCallId: call.call_id };
  }

  smsCapability(orgId: string): Promise<SmsCapability> {
    return this.sms.capability(orgId);
  }

  sendSms(orgId: string, to: string, text: string, ctx: { leadId?: string } = {}): Promise<{ id?: string }> {
    return this.sms.sendSms(orgId, to, text, ctx);
  }

  async providerLimit(orgId: string): Promise<number | null> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) return null;
    return (await retell<{ concurrency_limit?: number }>(c.apiKey, '/get-concurrency')).concurrency_limit ?? null;
  }
}

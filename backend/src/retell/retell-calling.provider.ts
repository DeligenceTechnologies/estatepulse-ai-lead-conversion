import { Injectable } from '@nestjs/common';
import type { CallContext, CallingProvider } from '@/calling/calling-providers';
import { AppError } from '@/common/errors/app-error';
import { ActivityService } from '@/telnyx/activity.service';
import { retell } from './retell-api';
import { RetellCredentialsService } from './retell-credentials.service';

/**
 * Retell places the call and runs the whole conversation on the
 * organization's agent; the lead's details travel as dynamic variables, the
 * same ones the Telnyx assistant gets. Voice only: the engine never asks it
 * for a text.
 */
@Injectable()
export class RetellCallingProvider implements CallingProvider {
  readonly name = 'retell' as const;
  readonly capabilities = { sms: false };

  constructor(
    private readonly creds: RetellCredentialsService,
    private readonly activity: ActivityService,
  ) {}

  async startCall(orgId: string, to: string, ctx: CallContext): Promise<{ providerCallId?: string }> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.active || !c.apiKey) throw new Error('No provider connected');
    if (!c.agentId) throw new Error('No Retell agent configured');
    if (!c.fromNumber) throw new Error('No from number configured');
    const call = await retell<{ call_id?: string }>(c.apiKey, '/v2/create-phone-call', {
      method: 'POST',
      body: JSON.stringify({
        from_number: c.fromNumber,
        to_number: to,
        override_agent_id: c.agentId,
        retell_llm_dynamic_variables: await this.activity.callVariables(orgId, ctx.leadId),
        metadata: { ...ctx },
        honor_internal_dnc: true,
      }),
    });
    return { providerCallId: call.call_id };
  }

  async sendSms(): Promise<{ id?: string }> {
    throw new AppError('CONFLICT', 'Retell sends no SMS from this app.');
  }

  async providerLimit(orgId: string): Promise<number | null> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) return null;
    return (await retell<{ concurrency_limit?: number }>(c.apiKey, '/get-concurrency')).concurrency_limit ?? null;
  }
}

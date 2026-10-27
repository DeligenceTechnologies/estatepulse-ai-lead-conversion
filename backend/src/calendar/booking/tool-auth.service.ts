import { Injectable } from '@nestjs/common';
import { AssistantToolAuth, type AssistantToolCaller, type ToolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
import { InCallBookingSettingsService, type InCallBookingConfig } from './in-call-booking-settings.service';

export type { ToolRequest } from '@/telnyx/tools/assistant-tool-auth.service';

export interface ToolContext extends AssistantToolCaller {
  config: InCallBookingConfig;
}

/**
 * Proves a booking tool request came from the organization's own assistant
 * (see AssistantToolAuth), with the booking tools' token, while in-call
 * booking is on.
 */
@Injectable()
export class ToolAuthService {
  constructor(
    private readonly auth: AssistantToolAuth,
    private readonly settings: InCallBookingSettingsService,
  ) {}

  async verify(req: ToolRequest): Promise<ToolContext> {
    const configs = new Map<string, InCallBookingConfig>();
    const caller = await this.auth.verify(req, 'booking', async (orgId) => {
      const config = await this.settings.activeConfig(orgId);
      if (config) configs.set(orgId, config);
      return config?.tokenHash ?? null;
    });
    return { ...caller, config: configs.get(caller.orgId)! };
  }
}

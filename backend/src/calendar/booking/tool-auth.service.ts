import { Injectable } from '@nestjs/common';
import { RetellToolAuthService, type RetellToolRequest } from '@/retell/retell-tool-auth.service';
import { AssistantToolAuth, type AssistantToolCaller, type ToolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
import { InCallBookingSettingsService, type InCallBookingConfig } from './in-call-booking-settings.service';

export type { ToolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
export type { RetellToolRequest } from '@/retell/retell-tool-auth.service';

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
    private readonly retellAuth: RetellToolAuthService,
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

  /**
   * The same proof for the Retell agent's custom functions (see
   * RetellToolAuthService): our bearer token from the tool's headers, a live
   * Retell call or an ongoing Retell text chat, and Retell's signature, while
   * in-call booking is on for Retell.
   */
  async verifyRetell(req: RetellToolRequest): Promise<ToolContext> {
    const configs = new Map<string, InCallBookingConfig>();
    const caller = await this.retellAuth.verify(req, 'booking', async (orgId) => {
      const config = await this.settings.activeConfig(orgId);
      if (config?.provider !== 'retell') return null;
      configs.set(orgId, config);
      return config.tokenHash;
    });
    return { ...caller, config: configs.get(caller.orgId)! };
  }
}

import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';

/**
 * Whether outreach scheduling is on for this server, asked before anything else under
 * /outreach: switched off, those routes answer 404, and a screen that asked first never
 * calls them (no failed request, no console error). Outside OutreachController on purpose,
 * since its guard would answer this one 404 too.
 */
@Controller('outreach')
export class OutreachCapabilityController {
  constructor(private readonly config: ConfigService<IntegrationEnv, true>) {}

  @Get('enabled')
  enabled(): { enabled: boolean } {
    return { enabled: !!this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true }) };
  }
}

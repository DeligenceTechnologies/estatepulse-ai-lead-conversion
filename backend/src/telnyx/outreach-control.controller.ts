import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { OutreachControlService } from './outreach-control.service';

export class PauseOutreachDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/**
 * Pause and resume on the lead's page. An agent may do it on their own leads and an admin on any
 * lead: the lead must be one the user can see, and lead.update is needed to change anything.
 */
@Controller('leads')
export class OutreachControlController {
  constructor(private readonly outreach: OutreachControlService) {}

  @Get(':id/outreach')
  state(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.outreach.state(auth, id);
  }

  /** What pausing or resuming would change, for the confirmation before it. */
  @Get(':id/outreach/pause-plan')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async pausePlan(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const { lines, notes } = await this.outreach.pausePlan(auth, id);
    return { lines, notes };
  }

  @Get(':id/outreach/resume-plan')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async resumePlan(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const { lines, notes } = await this.outreach.resumePlan(auth, id);
    return { lines, notes };
  }

  @Post(':id/outreach/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PauseOutreachDto) {
    return this.outreach.pause(auth, id, { source: 'agent', reason: body.reason });
  }

  @Post(':id/outreach/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  resume(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.outreach.resume(auth, id, { source: 'agent' });
  }
}

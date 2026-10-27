import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { EngineService } from './engine.service';

export class SetAutomationDto {
  @IsBoolean()
  paused!: boolean;
}

export class MarkBookedDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** The two quick actions on a lead: switch its automation off or on, and record a meeting set outside the app. */
@Controller('leads')
export class LeadAutomationController {
  constructor(
    private readonly engine: EngineService,
    private readonly audit: AuditService,
  ) {}

  @Post(':id/automation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async setAutomation(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetAutomationDto) {
    await this.engine.setAutomationPaused(auth.organizationId, id, body.paused);
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: body.paused ? 'lead.automation_paused' : 'lead.automation_resumed',
      entityType: 'lead',
      entityId: id,
    });
    return { ok: true, automationPaused: body.paused };
  }

  @Post(':id/booked')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async markBooked(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: MarkBookedDto) {
    await this.engine.markBooked(auth.organizationId, id);
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'lead.marked_booked',
      entityType: 'lead',
      entityId: id,
      ...(body.note?.trim() ? { payload: { note: body.note.trim() } } : {}),
    });
    return { ok: true, status: 'appointment_booked' };
  }
}

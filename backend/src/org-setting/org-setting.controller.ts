import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { LeadAssignmentDto } from './dto/lead-assignment.dto';
import { UpdateOrgSettingDto } from './dto/update-org-setting.dto';
import { OrgSettingService } from './org-setting.service';

@Controller('org-settings')
export class OrgSettingController {
  constructor(private readonly orgSettingService: OrgSettingService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  find(@CurrentAuth() auth: AuthContext) {
    return this.orgSettingService.find(auth.organizationId);
  }

  @Patch()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  update(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateOrgSettingDto) {
    return this.orgSettingService.update(auth.organizationId, dto);
  }

  @Put('lead-assignment')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  setLeadAssignment(@CurrentAuth() auth: AuthContext, @Body() dto: LeadAssignmentDto) {
    return this.orgSettingService.setLeadAssignment(auth.organizationId, auth.userId, dto.assignToMe);
  }
}

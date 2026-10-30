import { Controller, Get, Body, Patch, Param, Delete, ParseUUIDPipe, NotFoundException } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { OrganizationService } from './organization.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Controller('organization')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  findOne(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.organizationService.findOne(this.ownOrgId(auth, id));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrganizationDto: UpdateOrganizationDto,
  ) {
    return this.organizationService.update(this.ownOrgId(auth, id), updateOrganizationDto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.organizationService.remove(this.ownOrgId(auth, id));
  }

  /** Another org's id gets a 404, so callers can't tell whether it exists. */
  private ownOrgId(auth: AuthContext, id: string): string {
    if (id !== auth.organizationId) throw new NotFoundException('Organization not found');
    return id;
  }
}

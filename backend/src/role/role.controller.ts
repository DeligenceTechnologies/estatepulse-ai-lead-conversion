import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { PERMISSIONS } from './permissions';
import { RoleService } from './role.service';

@Controller('roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  /** The permission catalog, grouped by module, for the role editor UI. */
  @Get('permissions')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  listPermissions() {
    return this.roleService.listPermissions();
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  findAll(@Query() query: ListQuery) {
    return this.roleService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.roleService.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ROLE_CREATE)
  create(@Body() dto: CreateRoleDto, @CurrentAuth() auth: AuthContext) {
    return this.roleService.create(dto, auth);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ROLE_UPDATE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ROLE_DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.roleService.remove(id);
  }
}

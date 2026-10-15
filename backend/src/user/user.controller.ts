import { Controller, Get, Post, Body, Patch, Param, Delete, ParseUUIDPipe, Query } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.USER_CREATE)
  create(@Body() createUserDto: CreateUserDto, @CurrentAuth() auth: AuthContext) {
    return this.userService.create({ ...createUserDto, orgId: auth.organizationId });
  }

  @Get()
  @RequirePermissions(PERMISSIONS.USER_READ)
  findAll(@Query() query: ListQuery, @CurrentAuth() auth: AuthContext) {
    return this.userService.findAll(query, auth);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.USER_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) {
    return this.userService.findOne(id, auth.organizationId);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_UPDATE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() updateUserDto: UpdateUserDto, @CurrentAuth() auth: AuthContext) {
    return this.userService.update(id, auth.organizationId, updateUserDto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.USER_DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) {
    return this.userService.remove(id, auth.organizationId);
  }
}

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
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.USER_READ)
  findAll(@Query() query: ListQuery, @CurrentAuth() auth: AuthContext) {
    return this.userService.findAll(query, auth);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.USER_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_UPDATE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.USER_DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.remove(id);
  }
}

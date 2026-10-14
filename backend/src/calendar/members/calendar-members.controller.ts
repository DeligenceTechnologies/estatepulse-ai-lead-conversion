import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CALENDAR_ROUTE } from '../calendar.types';
import { CalendarMembersService } from './calendar-members.service';
import { AddCalendarMemberDto } from './dto/add-member.dto';

@Controller(CALENDAR_ROUTE)
export class CalendarMembersController {
  constructor(private readonly members: CalendarMembersService) {}

  @Get('members')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  list(@CurrentAuth() auth: AuthContext) {
    return this.members.list(auth.organizationId);
  }

  @Post('members/add-agent')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ, PERMISSIONS.USER_CREATE)
  addAsAgent(@CurrentAuth() auth: AuthContext, @Body() dto: AddCalendarMemberDto) {
    return this.members.addAsAgent(auth.organizationId, dto.externalId);
  }
}

import { Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { SmsConversationService } from './sms-conversation.service';

/** Whether the AI assistant answers a lead's texts, or a person does. */
@Controller('sms-conversation')
export class SmsConversationController {
  constructor(private readonly conversations: SmsConversationService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.conversations.status(auth.organizationId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  enable(@CurrentAuth() auth: AuthContext) {
    return this.conversations.enable(auth.organizationId);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  disable(@CurrentAuth() auth: AuthContext) {
    return this.conversations.disable(auth.organizationId);
  }
}

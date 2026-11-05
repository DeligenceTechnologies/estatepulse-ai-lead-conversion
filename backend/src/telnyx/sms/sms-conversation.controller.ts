import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { UpdateBusinessDetailsDto, UpdateTakeoverGreetingDto } from '../dto/telnyx.dto';
import { BusinessDetailsService } from './business-details.service';
import { ChatTakeoverService } from './chat-takeover.service';
import { SmsConversationService } from './sms-conversation.service';

/** Whether the AI assistant answers a lead's texts, or a person does, what the lead is told when an agent takes over, and who the organization is in its texts. */
@Controller('sms-conversation')
export class SmsConversationController {
  constructor(
    private readonly conversations: SmsConversationService,
    private readonly chats: ChatTakeoverService,
    private readonly business: BusinessDetailsService,
  ) {}

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

  @Get('takeover-greeting')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  takeoverGreeting(@CurrentAuth() auth: AuthContext) {
    return this.chats.greeting(auth.organizationId);
  }

  @Put('takeover-greeting')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  updateTakeoverGreeting(@CurrentAuth() auth: AuthContext, @Body() body: UpdateTakeoverGreetingDto) {
    return this.chats.updateGreeting(auth.organizationId, body);
  }

  @Get('business-details')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  businessDetails(@CurrentAuth() auth: AuthContext) {
    return this.business.view(auth.organizationId);
  }

  @Put('business-details')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  updateBusinessDetails(@CurrentAuth() auth: AuthContext, @Body() body: UpdateBusinessDetailsDto) {
    return this.business.update(auth.organizationId, body);
  }
}

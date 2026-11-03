import { Body, Controller, Get, Put } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { UpdateVoicemailDto } from '../dto/telnyx.dto';
import { VoicemailService } from './voicemail.service';

/** What an AI call leaves on an answering machine. */
@Controller('voicemail')
export class VoicemailController {
  constructor(private readonly voicemail: VoicemailService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.voicemail.status(auth.organizationId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  update(@CurrentAuth() auth: AuthContext, @Body() body: UpdateVoicemailDto) {
    return this.voicemail.update(auth.organizationId, body);
  }
}

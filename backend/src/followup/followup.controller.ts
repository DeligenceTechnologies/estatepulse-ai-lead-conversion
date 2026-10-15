import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CreateSequenceDto, EnrollLeadsDto, LeadFilterDto, ReplaceStepsDto, UpdateSequenceDto } from './dto/sequence.dto';
import { FollowupService } from './followup.service';

@Controller('v1/sequences')
export class FollowupController {
  constructor(private readonly followup: FollowupService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  list(@CurrentAuth() auth: AuthContext) {
    return this.followup.listSequences(auth.organizationId);
  }

  @Get('enrollments')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  enrollments(@CurrentAuth() auth: AuthContext, @Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    return this.followup.listEnrollments(auth.organizationId, limit ?? 100);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.followup.getSequence(auth.organizationId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateSequenceDto) {
    return this.followup.createSequence(auth.organizationId, body);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSequenceDto) {
    return this.followup.updateSequence(auth.organizationId, id, body);
  }

  @Put(':id/steps')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  replaceSteps(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReplaceStepsDto) {
    return this.followup.replaceSteps(auth.organizationId, id, body);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  archive(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.followup.archiveSequence(auth.organizationId, id);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  preview(@CurrentAuth() auth: AuthContext, @Body() body: LeadFilterDto) {
    return this.followup.previewFilter(auth.organizationId, body);
  }

  @Post(':id/enroll')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  enroll(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: EnrollLeadsDto) {
    return this.followup.enrollLeads(auth.organizationId, id, body, auth.userId);
  }

  @Post('enrollments/:id/stop')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  stop(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.followup.stopEnrollment(auth.organizationId, id);
  }
}

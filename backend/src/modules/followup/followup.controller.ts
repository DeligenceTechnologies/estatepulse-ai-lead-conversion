import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { FollowupService } from './followup.service';
import {
  createSequenceSchema,
  enrollSchema,
  leadFilterSchema,
  replaceStepsSchema,
  updateSequenceSchema,
  type CreateSequenceInput,
  type EnrollInput,
  type LeadFilterInput,
  type ReplaceStepsInput,
  type UpdateSequenceInput,
} from './schemas';

/**
 * Reading the Follow-ups screen needs a session; changing what the office
 * sends to its leads needs the owner.
 *
 * That split is why there are two controllers on one path rather than one
 * class with mixed guards: authoring a sequence sets up automated messages to
 * real people for weeks, which is an owner's decision in the same way adding
 * an agent is. Nest matches both on `api/v1/sequences`, and each route is
 * protected by its class rather than by remembering a decorator.
 *
 * The organization is never a route parameter. It comes from
 * `auth.organizationId`, so there is nothing a caller can send to address
 * another tenant, and every :id is resolved WITHIN the caller's organization.
 */
@Controller('api/v1/sequences')
@UseGuards(SessionGuard)
export class FollowupController {
  constructor(private readonly followup: FollowupService) {}

  @Get()
  list(@Req() req: SessionRequest) {
    return this.followup.listSequences(req.auth.organizationId);
  }

  @Get('enrollments')
  enrollments(@Req() req: SessionRequest, @Query('limit') limit?: string) {
    return this.followup.listEnrollments(req.auth.organizationId, limit);
  }

  @Get(':id')
  get(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.followup.getSequence(req.auth.organizationId, id);
  }
}

/** Everything that changes what gets sent. Owner only. */
@Controller('api/v1/sequences')
@UseGuards(SessionGuard, OwnerGuard)
export class FollowupAdminController {
  constructor(private readonly followup: FollowupService) {}

  @Post()
  create(
    @Req() req: SessionRequest,
    @Body(new ZodValidationPipe(createSequenceSchema)) body: CreateSequenceInput,
  ) {
    return this.followup.createSequence(req.auth.organizationId, body);
  }

  @Patch(':id')
  update(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSequenceSchema)) body: UpdateSequenceInput,
  ) {
    return this.followup.updateSequence(req.auth.organizationId, id, body);
  }

  /** PUT, not PATCH: the editor sends the whole list and it replaces the whole list. */
  @Put(':id/steps')
  replaceSteps(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(replaceStepsSchema)) body: ReplaceStepsInput,
  ) {
    return this.followup.replaceSteps(req.auth.organizationId, id, body);
  }

  /** Archives. See FollowupService.archiveSequence for why nothing is deleted. */
  @Delete(':id')
  archive(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.followup.archiveSequence(req.auth.organizationId, id);
  }

  /**
   * Who a set of conditions would add. Separate from the enrol call so the UI
   * can show a count and a sample before anyone commits to texting them —
   * `enroll` with `dryRun` answers the same question, but this one needs no
   * sequence and so works while the user is still choosing one.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Req() req: SessionRequest,
    @Body(new ZodValidationPipe(leadFilterSchema)) body: LeadFilterInput,
  ) {
    return this.followup.previewFilter(req.auth.organizationId, body);
  }

  @Post(':id/enroll')
  @HttpCode(HttpStatus.OK)
  enroll(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(enrollSchema)) body: EnrollInput,
  ) {
    // The user id is recorded on every row this creates: "did somebody add
    // this person or did the system" is the first question asked when a lead
    // complains about a text.
    return this.followup.enrollLeads(req.auth.organizationId, id, body, req.auth.userId);
  }

  @Post('enrollments/:id/stop')
  @HttpCode(HttpStatus.OK)
  stop(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.followup.stopEnrollment(req.auth.organizationId, id);
  }
}

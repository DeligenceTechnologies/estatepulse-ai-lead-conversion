import { Body, Controller, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '../../auth/types';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { LeadAssignmentService, type LeadAssignmentDTO } from './lead-assignment.service';

/**
 * Strict, like every write body here: a body naming an organization, an
 * assignment type or a reason is refused rather than ignored. The type is
 * always 'manual' on this route and the organization is the session's.
 */
const assignLeadSchema = z.object({ agentId: z.string().uuid('agentId must be an agent profile id') }).strict();
type AssignLeadInput = z.infer<typeof assignLeadSchema>;

/**
 * Owner-only manual assignment. A separate controller from LeadsController
 * because that one is read-only by design and accepts API keys; a write that
 * changes who works a lead needs a signed-in owner, never a machine credential.
 *
 * Both guards on the class, in order: SessionGuard resolves the membership,
 * OwnerGuard reads the role from it.
 */
@Controller('api/v1/leads')
@UseGuards(SessionGuard, OwnerGuard)
export class LeadAssignmentController {
  constructor(private readonly assignments: LeadAssignmentService) {}

  /**
   * PUT: the body is the whole desired state — "this lead is with this agent" —
   * and repeating it changes nothing. Assigning an already-assigned lead to
   * someone else is a reassignment, recorded as one.
   */
  @Put(':leadId/assignment')
  assign(
    @CurrentUser() auth: AuthContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body(new ZodValidationPipe(assignLeadSchema, 'Invalid assignment')) body: AssignLeadInput,
  ): Promise<LeadAssignmentDTO> {
    return this.assignments.assign(auth.organizationId, auth.userId, leadId, body.agentId);
  }
}

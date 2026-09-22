import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../../auth/types';
import { AgentsService } from './agents.service';
import {
  createAgentSchema,
  isStatusUpdate,
  updateAgentSchema,
  type CreateAgentInput,
  type UpdateAgentInput,
} from './schemas';
import type { CreateAgentResultDTO, OrganizationMemberDTO } from './types';

/**
 * Owner-only management of the organization's people.
 *
 * The full path is declared here rather than through setGlobalPrefix, which is
 * how every controller in this application is wired — see the comment in
 * server.ts for why the prefix is not global.
 *
 * Both guards are on the class, so a route added later is protected by default
 * rather than by remembering. Order matters: SessionGuard resolves the caller's
 * membership and puts it on the request, OwnerGuard reads the role from it.
 *
 * The organization is never a parameter of these routes. It comes from
 * `auth.organizationId`, which SessionGuard resolved from organization_members
 * on this request — so there is nothing a caller can send to address another
 * tenant, and :userId is only ever resolved WITHIN the caller's organization.
 */
@Controller('api/agents')
@UseGuards(SessionGuard, OwnerGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** The whole roster, owner included — it is the organization's member list. */
  @Get()
  list(@CurrentUser() auth: AuthContext): Promise<OrganizationMemberDTO[]> {
    return this.agents.list(auth.organizationId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(createAgentSchema, 'Invalid agent details')) body: CreateAgentInput,
  ): Promise<CreateAgentResultDTO> {
    return this.agents.create(auth.organizationId, auth.userId, body);
  }

  /**
   * :userId is users.id. ParseUUIDPipe rejects a malformed id with a 400 before
   * any query runs, which keeps a garbage path out of the database entirely.
   *
   * Two edits behind one route, because they address one resource: the
   * membership switch (`status`) and the agent's profile. The schema refuses a
   * body carrying both, so this branch is total — see updateAgentSchema for why
   * they are not combinable.
   */
  @Patch(':userId')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(updateAgentSchema, 'Invalid agent update'))
    body: UpdateAgentInput,
  ): Promise<OrganizationMemberDTO> {
    return isStatusUpdate(body)
      ? this.agents.setStatus(auth.organizationId, auth.userId, userId, body.status)
      : this.agents.updateProfile(auth.organizationId, auth.userId, userId, body);
  }

}

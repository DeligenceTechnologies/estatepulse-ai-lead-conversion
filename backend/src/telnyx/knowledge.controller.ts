import { Body, Controller, Get, Logger, Put } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssistantService } from './assistant.service';
import { KnowledgeDto } from './dto/telnyx.dto';
import { KnowledgeService } from './knowledge.service';
import { ASSISTANT_NOT_UPDATED } from './portal.controller';

/**
 * The business facts the AI answers a lead's questions from, on calls and in
 * texts. The organization comes from the caller's credential; it is never read
 * from the body.
 */
@Controller('knowledge')
export class KnowledgeController {
  private readonly logger = new Logger(KnowledgeController.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly assistants: AssistantService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.knowledge.status(auth.organizationId);
  }

  /**
   * Saves the facts, then writes them into the assistant's prompt. A provider
   * that cannot be reached is a warning, not a failure: the save stands, and
   * `ensureCallSetup` writes the section before the next call.
   */
  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async save(@CurrentAuth() auth: AuthContext, @Body() body: KnowledgeDto) {
    const orgId = auth.organizationId;
    const status = await this.knowledge.set(orgId, body.entries);
    let warning: string | null = null;
    await this.assistants.syncKnowledge(orgId).catch((error) => {
      this.logger.warn(`knowledge sync for org ${orgId}: ${(error as Error).message}`);
      warning = ASSISTANT_NOT_UPDATED;
    });
    return { ...status, warning };
  }
}

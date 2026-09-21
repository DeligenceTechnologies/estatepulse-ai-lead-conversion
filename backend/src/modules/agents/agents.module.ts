import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { AgentMeController } from './agent-me.controller';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * AuthModule is imported for SessionGuard, which it provides and exports.
 * OwnerGuard has no dependencies of its own and is registered here so the
 * container can construct it for @UseGuards.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  // AgentMeController is the agent's own read-only surface; AgentsController
  // is the owner's roster management. Different audiences, different guards.
  controllers: [AgentsController, AgentMeController],
  providers: [AgentsService, OwnerGuard],
})
export class AgentsModule {}

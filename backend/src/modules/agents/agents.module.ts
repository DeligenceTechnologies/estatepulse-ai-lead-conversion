import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { MailModule } from '../../mail/mail.module';
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
  // MailModule is imported for the credentials email sent when an owner
  // creates an agent. It is inert unless SMTP_HOST is configured.
  imports: [PrismaModule, AuthModule, MailModule],
  controllers: [AgentsController, AgentMeController],
  providers: [AgentsService, OwnerGuard],
})
export class AgentsModule {}

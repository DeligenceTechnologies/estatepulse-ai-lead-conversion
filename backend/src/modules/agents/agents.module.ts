import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * AuthModule is imported for SessionGuard, which it provides and exports.
 * OwnerGuard has no dependencies of its own and is registered here so the
 * container can construct it for @UseGuards.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService, OwnerGuard],
})
export class AgentsModule {}
